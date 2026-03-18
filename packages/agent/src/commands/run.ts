import { CommandOutput } from '../cli.js';
import colors from 'ansi-colors';
import {
  WorkflowManager,
  IterationStatusManager,
  JsonlLogger,
  ProjectConfigManager,
  showTitle,
  showProperties,
  showList,
  type StepResult,
  type WorkflowRunner,
  type OnStepComplete,
} from 'rover-core';
import {
  ROVER_LOG_FILENAME,
  AGENT_LOGS_DIR,
  AGENT_EXIT_CODE,
  isAgentStep,
  isLoopStep,
  type MCP,
  type WorkflowAgentStep,
  type WorkflowStep,
} from 'rover-schemas';
import type { McpServer } from '@agentclientprotocol/sdk';
import { parseCollectOptions } from '../lib/options.js';
import { ACPRunner } from '../lib/acp-runner.js';
import { createAgent } from '../lib/agents/index.js';
import {
  executeStep,
  isRetryableError,
  isTransientError,
  PauseWorkflowError,
  collectNestedStepIds,
  computeLoopSignature,
} from '../lib/step-executor.js';
import {
  clearCheckpointFile,
  createCheckpointStore,
  loadCheckpoint,
  saveCheckpoint,
  type CheckpointData,
  type CheckpointStore,
} from '../lib/checkpoint-store.js';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureExternalRepositoryStates } from '../lib/external-repositories.js';
export {
  isRetryableError,
  isTransientError,
  loadCheckpoint,
  saveCheckpoint,
  type CheckpointData,
};

const EXIT_SUCCESS = AGENT_EXIT_CODE.SUCCESS;
const EXIT_FAILED = AGENT_EXIT_CODE.FAILED;
const EXIT_PAUSED = AGENT_EXIT_CODE.PAUSED;

function workflowReasonCode(error?: string): string {
  const text = String(error || '').toLowerCase();
  if (!text) return 'workflow_failed';
  if (text.includes('credit limit') || text.includes('usage limit')) {
    return 'credit_limit';
  }
  if (text.includes('rate limit') || text.includes('too many requests')) {
    return 'rate_limit';
  }
  if (text.includes('auth') || text.includes('login') || text.includes('sign in')) {
    return 'auth_required';
  }
  if (text.includes('timeout') || text.includes('timed out') || text.includes('network')) {
    return 'network_timeout';
  }
  if (text.includes('step failure') || text.includes('step failed')) {
    return 'workflow_step_failed';
  }
  if (text.includes('signal')) {
    return 'signal_interrupt';
  }
  return 'workflow_failed';
}

/**
 * Helper function to display step results consistently
 */
function displayStepResults(stepName: string, result: StepResult): void {
  showTitle(`📊 Step Results: ${stepName}`);

  const props: Record<string, string> = {
    ID: colors.cyan(result.id),
    Status: result.success ? colors.green('✓ Success') : colors.red('✗ Failed'),
    Duration: colors.yellow(`${result.duration.toFixed(2)}s`),
  };

  if (result.error) {
    props['Error'] = colors.red(result.error);
  }

  showProperties(props);

  // Display outputs
  const outputEntries = Array.from(result.outputs.entries()).filter(
    ([key]) =>
      !key.startsWith('raw_') &&
      !key.startsWith('input_') &&
      key !== 'error' &&
      key !== 'error_code' &&
      key !== 'error_retryable'
  );

  if (outputEntries.length > 0) {
    const outputItems = outputEntries.map(([key, value]) => {
      // Truncate long values for display
      let displayValue =
        value.length > 100 ? value.substring(0, 100) + '...' : value;
      if (displayValue.includes('\n')) {
        displayValue = displayValue.split('\n')[0] + '...';
      }

      return `${key}: ${colors.cyan(displayValue)}`;
    });

    showList(outputItems, { title: colors.gray('Outputs:') });
  } else {
    console.log(colors.gray('No outputs extracted'));
  }
}

function tokenizeCommandString(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += '\\';
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Copy agent-produced logs from their source locations into the logs
 * directory so they are persisted on the host alongside rover.jsonl.
 */
function collectAgentLogs(logsDir: string, agentTool?: string): void {
  if (!agentTool) return;

  let sources: string[];
  try {
    sources = createAgent(agentTool).getLogSources();
  } catch {
    return;
  }
  if (sources.length === 0) return;

  const targetDir = join(logsDir, AGENT_LOGS_DIR);

  for (const src of sources) {
    if (!existsSync(src)) continue;
    try {
      mkdirSync(targetDir, { recursive: true });
      cpSync(src, targetDir, { recursive: true });
    } catch (err) {
      // Best-effort: don't fail the workflow for log collection errors,
      // but warn on permission issues so they're diagnosable.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        console.warn(
          colors.yellow(`⚠ Could not collect agent logs from ${src}: ${code}`)
        );
      }
    }
  }
}

/**
 * Convert a rover.json MCP entry to an ACP McpServer object.
 */
export function roverMcpToAcpServer(mcp: MCP): McpServer {
  const headerEntries = (mcp.headers || []).map(h => {
    const colonIdx = h.indexOf(':');
    if (colonIdx === -1) return { name: h.trim(), value: '' };
    return {
      name: h.slice(0, colonIdx).trim(),
      value: h.slice(colonIdx + 1).trim(),
    };
  });

  const envEntries = (mcp.envs || []).map(e => {
    const eqIdx = e.indexOf('=');
    if (eqIdx === -1) return { name: e, value: '' };
    return { name: e.slice(0, eqIdx), value: e.slice(eqIdx + 1) };
  });

  switch (mcp.transport) {
    case 'http':
      return {
        type: 'http' as const,
        name: mcp.name,
        url: mcp.commandOrUrl,
        headers: headerEntries,
      };
    case 'sse':
      return {
        type: 'sse' as const,
        name: mcp.name,
        url: mcp.commandOrUrl,
        headers: headerEntries,
      };
    case 'stdio':
    default: {
      const parts = tokenizeCommandString(mcp.commandOrUrl);
      if (parts.length === 0 || !parts[0]) {
        throw new Error(
          `MCP server "${mcp.name}" has an empty command. Check the "commandOrUrl" field in your configuration.`
        );
      }
      return {
        name: mcp.name,
        command: parts[0],
        args: parts.slice(1),
        env: envEntries,
      };
    }
  }
}

/**
 * Read MCP servers from rover.json at the given project path and convert them
 * to the ACP McpServer[] format.  Returns an empty array when no config exists.
 */
function loadMcpServersFromProject(projectPath: string): McpServer[] {
  try {
    if (!ProjectConfigManager.exists(projectPath)) return [];
    const config = ProjectConfigManager.load(projectPath);
    return config.mcps.map(roverMcpToAcpServer);
  } catch {
    return [];
  }
}

function captureCheckpointRepositoryState(
  checkpointData: CheckpointData
): void {
  try {
    const repositories = captureExternalRepositoryStates();
    checkpointData.externalRepositories =
      repositories.length > 0 ? repositories : undefined;
  } catch (error) {
    console.warn(
      colors.yellow(
        `Warning: Failed to snapshot external repositories for checkpoint resume: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    );
    checkpointData.externalRepositories = undefined;
  }
}

interface RunCommandOptions {
  // Inputs. Take precedence over files
  input: string[];
  // Load the inputs from a JSON file
  inputsJson?: string;
  // Tool to use instead of workflow defaults
  agentTool?: string;
  // Model to use instead of workflow defaults
  agentModel?: string;
  // Task ID for status tracking
  taskId?: string;
  // Path to status.json file
  statusFile?: string;
  // Optional output directory
  output?: string;
  // Path to the context directory
  contextDir?: string;
  // Path to checkpoint.json for resuming a paused workflow
  checkpoint?: string;
}

interface RunCommandOutput extends CommandOutput {
  paused?: boolean;
}

/**
 * Build context injection message from the context directory.
 * The context directory contains an index.md file and individual context source files.
 *
 * @param contextDir - Path to the context directory
 * @returns Context message to prepend to prompts, or null if no context
 */
function buildContextMessage(contextDir: string): string | null {
  const indexPath = `${contextDir}/index.md`;
  if (!existsSync(indexPath)) return null;

  const lines = [
    '\n\n**Context Sources:**',
    `The context directory at \`${contextDir}/\` contains reference materials for this task.`,
    `Read the index file at \`${contextDir}/index.md\` for a complete overview of all available context sources and their descriptions.`,
    '',
    '**Important:** Read the context index before proceeding with the task.',
    '',
  ];

  return lines.join('\n');
}

/**
 * Recursively inject context into agent steps, including those nested inside loops.
 */
function injectContextIntoSteps(
  steps: WorkflowStep[],
  contextMessage: string
): WorkflowStep[] {
  return steps.map(step => {
    if (isAgentStep(step)) {
      return { ...step, prompt: contextMessage + step.prompt };
    } else if (isLoopStep(step)) {
      return {
        ...step,
        steps: injectContextIntoSteps(step.steps, contextMessage),
      };
    }
    return step;
  });
}

/**
 * Inject context sources into workflow step prompts.
 * Reads from the context directory mounted at the path specified by --context-dir.
 *
 * @param options - Run command options
 * @param workflowManager - Workflow manager to inject context into
 */
const handleContextInjection = (
  options: RunCommandOptions,
  workflowManager: WorkflowManager
): void => {
  const contextDir = options.contextDir;
  if (!contextDir || !existsSync(contextDir)) return;

  const contextMessage = buildContextMessage(contextDir);

  if (contextMessage && workflowManager.steps.length > 0) {
    console.log(
      colors.gray('✓ Context sources injected into workflow steps\n')
    );

    workflowManager.steps = injectContextIntoSteps(
      workflowManager.steps,
      contextMessage
    );
  }
};

/**
 * Try to find the cached result for a step in the checkpoint data.
 * Returns a synthetic StepResult if found, undefined otherwise.
 */
function getCachedStepResult(
  checkpointStore: CheckpointStore | undefined,
  step: WorkflowStep,
  stepsOutput: Map<string, Map<string, string>>
): StepResult | undefined {
  if (!checkpointStore) return undefined;
  const cached = checkpointStore.getCompletedStep(step.id);
  if (!cached) return undefined;

  if (isLoopStep(step)) {
    for (const subStepId of step.steps.flatMap((subStep: WorkflowStep) =>
      collectNestedStepIds(subStep)
    )) {
      const subStep = checkpointStore.getCompletedStep(subStepId);
      if (!subStep) continue;
      stepsOutput.set(subStepId, new Map(Object.entries(subStep.outputs)));
    }
  }

  console.log(colors.gray(`\n⏭ Skipping completed step: ${step.name}`));
  return {
    id: step.id,
    success: true,
    duration: 0,
    outputs: new Map(Object.entries(cached.outputs)),
  };
}

function pruneStaleCheckpointEntries(
  checkpoint: CheckpointData,
  workflowManager: WorkflowManager
): {
  missingStepEntries: number;
  staleLoopStepEntries: number;
  staleLoopProgressEntries: number;
} {
  const loopSignatures = checkpoint.loopSignatures ?? {};
  const staleLoopIds = new Set<string>();
  const staleLoopStepIds = new Set<string>();
  let missingStepEntries = 0;
  let staleLoopStepEntries = 0;
  let staleLoopProgressEntries = 0;

  const collectNestedLoopIds = (step: WorkflowStep): string[] => {
    if (!('steps' in step) || !step.steps) return [];

    const nestedLoopIds: string[] = [];
    for (const subStep of step.steps) {
      if (isLoopStep(subStep)) {
        nestedLoopIds.push(subStep.id);
      }
      nestedLoopIds.push(...collectNestedLoopIds(subStep));
    }
    return nestedLoopIds;
  };

  const collectStaleLoopEntries = (steps: WorkflowStep[]): void => {
    for (const step of steps) {
      if (!isLoopStep(step)) continue;

      const isCurrentLoopSignature =
        loopSignatures[step.id] === computeLoopSignature(step);
      if (!isCurrentLoopSignature) {
        staleLoopIds.add(step.id);
        for (const nestedLoopId of collectNestedLoopIds(step)) {
          staleLoopIds.add(nestedLoopId);
        }
        for (const subStep of step.steps) {
          for (const stepId of collectNestedStepIds(subStep)) {
            staleLoopStepIds.add(stepId);
          }
        }
        continue;
      }

      collectStaleLoopEntries(step.steps);
    }
  };

  collectStaleLoopEntries(workflowManager.steps);

  checkpoint.completedSteps = checkpoint.completedSteps.filter(
    completedStep => {
      if (
        staleLoopIds.has(completedStep.id) ||
        staleLoopStepIds.has(completedStep.id)
      ) {
        staleLoopStepEntries++;
        return false;
      }

      const workflowStep = workflowManager.findStep(completedStep.id);
      if (!workflowStep) {
        missingStepEntries++;
        return false;
      }
      if (!isLoopStep(workflowStep)) {
        return true;
      }

      const isCurrentLoopSignature =
        loopSignatures[workflowStep.id] === computeLoopSignature(workflowStep);
      if (!isCurrentLoopSignature) {
        staleLoopStepEntries++;
        return false;
      }
      return true;
    }
  );

  if (checkpoint.loopProgress) {
    checkpoint.loopProgress = Object.fromEntries(
      Object.entries(checkpoint.loopProgress).filter(([loopId]) => {
        if (staleLoopIds.has(loopId)) {
          staleLoopProgressEntries++;
          return false;
        }

        const workflowStep = workflowManager.findStep(loopId);
        if (!workflowStep || !isLoopStep(workflowStep)) {
          staleLoopProgressEntries++;
          return false;
        }

        const isCurrentLoopSignature =
          loopSignatures[loopId] === computeLoopSignature(workflowStep);
        if (!isCurrentLoopSignature) {
          staleLoopProgressEntries++;
          return false;
        }

        return true;
      })
    );

    if (Object.keys(checkpoint.loopProgress).length === 0) {
      delete checkpoint.loopProgress;
    }
  }

  if (checkpoint.loopSignatures) {
    checkpoint.loopSignatures = Object.fromEntries(
      Object.entries(checkpoint.loopSignatures).filter(
        ([loopId, signature]) => {
          if (staleLoopIds.has(loopId)) {
            return false;
          }

          const workflowStep = workflowManager.findStep(loopId);
          return (
            workflowStep != null &&
            isLoopStep(workflowStep) &&
            signature === computeLoopSignature(workflowStep)
          );
        }
      )
    );

    if (Object.keys(checkpoint.loopSignatures).length === 0) {
      delete checkpoint.loopSignatures;
    }
  }

  return {
    missingStepEntries,
    staleLoopStepEntries,
    staleLoopProgressEntries,
  };
}

/**
 * Run a specific agent workflow file definition. It performs a set of validations
 * to confirm everything is ready and goes through the different steps.
 */
export const runCommand = async (
  workflowPath: string,
  options: RunCommandOptions = { input: [] }
) => {
  const output: RunCommandOutput = {
    success: false,
  };

  // Declare status manager outside try block so it's accessible in catch
  let statusManager: IterationStatusManager | undefined;
  let totalDuration = 0;
  let sigtermHandler: (() => void) | undefined;
  let sigintHandler: (() => void) | undefined;
  let shutdownSignal: string | undefined;
  let resolvedAgentTool: string | undefined;

  // Determine the logs directory. Prefer /logs (bind-mounted by the sandbox
  // to the project-level logs directory), fall back to the output directory.
  const logsDir = existsSync('/logs') ? '/logs' : options.output;

  // Create JSONL logger for rover-specific structured logs.
  let logger: JsonlLogger | undefined;
  if (logsDir) {
    try {
      logger = new JsonlLogger(join(logsDir, ROVER_LOG_FILENAME));
    } catch (error) {
      console.log(
        colors.yellow(
          `Warning: Failed to initialize JSONL logger: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  try {
    // Validate status tracking options
    if (options.statusFile && !options.taskId) {
      console.log(
        colors.red('\n✗ --task-id is required when --status-file is provided')
      );
      process.exit(EXIT_FAILED);
    }

    // Check if the output folder exists.
    if (options.output && !existsSync(options.output)) {
      console.log(
        colors.red(
          `\n✗ The "${options.output}" directory does not exist or current user does not have permissions.`
        )
      );
      process.exit(EXIT_FAILED);
    }

    // Create status manager if status file is provided
    if (options.statusFile && options.taskId) {
      try {
        statusManager = IterationStatusManager.createInitial(
          options.statusFile,
          options.taskId,
          'Starting workflow'
        );
      } catch (error) {
        console.log(
          colors.red(
            `\n✗ Failed to initialize status file: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        output.error = `Failed to initialize status file: ${error}`;
        return;
      }
    }

    // Load the agent workflow
    const workflowManager = WorkflowManager.load(workflowPath);

    // Always inject context into the in-memory workflow before execution.
    // Checkpoints only persist outputs/state, not mutated prompts.
    handleContextInjection(options, workflowManager);

    let providedInputs = new Map();

    if (options.inputsJson != null) {
      console.log(colors.gray(`Loading inputs from ${options.inputsJson}\n`));
      if (!existsSync(options.inputsJson)) {
        console.log(
          colors.yellow(
            `The provided JSON input file (${options.inputsJson}) does not exist. Skipping it.`
          )
        );
      } else {
        try {
          const jsonData = readFileSync(options.inputsJson, 'utf-8');
          const data = JSON.parse(jsonData);

          for (const key in data) {
            providedInputs.set(key, data[key]);
          }
        } catch (err) {
          console.log(
            colors.yellow(
              `The provided JSON input file (${options.inputsJson}) is not a valid JSON. Skipping it.`
            )
          );
        }
      }
    }

    // Users might override the --inputs-json values with --input.
    // The --input always have preference
    providedInputs = parseCollectOptions(options.input, providedInputs);

    // Merge provided inputs with defaults
    const inputs = new Map(providedInputs);
    const defaultInputs: Array<string> = [];

    // Add default values for required inputs that weren't provided
    for (const input of workflowManager.inputs) {
      if (!inputs.has(input.name) && input.default !== undefined) {
        inputs.set(input.name, String(input.default));
        defaultInputs.push(input.name);
      }
    }

    showTitle('Agent Workflow');
    showProperties({
      Name: colors.cyan(workflowManager.name),
      Description: workflowManager.description,
    });

    const inputItems = Array.from(inputs.entries()).map(([key, value]) => {
      const isDefault = defaultInputs.includes(key);
      const suffix = isDefault ? colors.gray(' (default)') : '';
      return `${key}=${colors.cyan(String(value))}${suffix}`;
    });
    showList(inputItems, {
      title: colors.bold('User inputs'),
      addLineBreak: true,
    });

    // Validate inputs against workflow requirements
    const validation = workflowManager.validateInputs(inputs);

    // Display warnings if any
    if (validation.warnings.length > 0) {
      showList(
        validation.warnings.map((w: string) => colors.yellow(w)),
        { title: colors.yellow.bold('Warnings'), addLineBreak: true }
      );
    }

    // Check for validation errors
    if (!validation.valid) {
      validation.errors.forEach(error => {
        console.log(colors.red(`\n✗ ${error}`));
      });
      output.success = false;
      output.error = `Input validation failed: ${validation.errors.join(', ')}`;
    } else {
      // Continue with workflow run

      // Load checkpoint if resuming from a paused workflow
      let checkpoint: CheckpointData | null = null;
      if (options.checkpoint) {
        checkpoint = loadCheckpoint(options.checkpoint);
        if (checkpoint) {
          const {
            missingStepEntries,
            staleLoopStepEntries,
            staleLoopProgressEntries,
          } = pruneStaleCheckpointEntries(checkpoint, workflowManager);

          if (missingStepEntries > 0) {
            console.log(
              colors.yellow(
                `\n⚠ Dropped ${missingStepEntries} checkpoint entry(s) referencing steps no longer in the workflow`
              )
            );
          }

          const staleLoopEntries =
            staleLoopStepEntries + staleLoopProgressEntries;
          if (staleLoopEntries > 0) {
            console.log(
              colors.yellow(
                `\n⚠ Dropped ${staleLoopEntries} stale loop checkpoint entr${staleLoopEntries === 1 ? 'y' : 'ies'} because the loop definition changed`
              )
            );
          }

          console.log(
            colors.cyan(
              `\n🔄 Resuming from checkpoint: ${checkpoint.completedSteps.length} step(s) will be skipped`
            )
          );
          logger?.info(
            'workflow_resume',
            `Resuming from checkpoint with ${checkpoint.completedSteps.length} completed step(s)`,
            {
              taskId: options.taskId,
              metadata: {
                completedSteps: checkpoint.completedSteps.length,
                failedStepId: checkpoint.failedStepId,
              },
            }
          );
        } else {
          console.log(
            colors.yellow(
              '\n⚠ Checkpoint file not found or invalid, running full workflow'
            )
          );
        }
      }
      const checkpointStore = createCheckpointStore(options.output, checkpoint);
      // Shared with signal handlers so Ctrl+C/termination can close ACP cleanly.
      let acpRunner: ACPRunner | undefined;

      // Register signal handlers for graceful checkpoint save on termination.
      // Without these, a SIGTERM/SIGINT during step execution would lose any
      // in-flight checkpoint state between step completion and the next persist.
      let shuttingDown = false;
      const gracefulShutdown = (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        // Remove signal listeners to prevent re-entry from a second
        // signal arriving before the rest of this handler completes.
        if (sigtermHandler) process.off('SIGTERM', sigtermHandler);
        if (sigintHandler) process.off('SIGINT', sigintHandler);
        shutdownSignal = signal;
        output.success = false;
        output.error = `Workflow paused by ${signal} signal`;
        const currentStep =
          statusManager?.currentStep || 'Workflow execution interrupted';
        console.log(
          colors.yellow(
            `\n⚠ Received ${signal} — saving checkpoint before exit...`
          )
        );
        const checkpointData = checkpointStore.getData();
        try {
          captureCheckpointRepositoryState(checkpointData);
        } catch (captureErr) {
          console.warn(
            colors.yellow(
              `⚠ Failed to capture repository state during shutdown: ${captureErr instanceof Error ? captureErr.message : String(captureErr)}`
            )
          );
        }
        // INVARIANT: saveCheckpoint must use synchronous I/O (writeFileSync)
        // because process.exit() is called immediately after. Do NOT make this async.
        const saved = saveCheckpoint(options.output, checkpointData);
        // Set output.paused only if checkpoint was actually saved, so
        // downstream consumers (retry scheduler, exit code) stay consistent.
        output.paused = saved;
        if (saved) {
          statusManager?.pause(currentStep, output.error);
        } else {
          statusManager?.fail(currentStep, output.error);
          const completedIds = checkpointData.completedSteps
            .map(s => s.id)
            .join(', ');
          console.warn(
            colors.yellow(
              `⚠ WARNING: Checkpoint could not be saved (no --output directory). Exiting as failed.\n` +
                `  Completed steps: ${completedIds || '(none)'}`
            )
          );
        }
        // Collect agent-specific logs before exiting so diagnostics are
        // preserved even when the workflow is interrupted by a signal.
        if (logsDir) {
          collectAgentLogs(logsDir, resolvedAgentTool);
        }
        // Log the pause event before exiting so it's captured in structured logs.
        logger?.info(
          'workflow_pause',
          output.error || 'Workflow paused by signal',
          {
            taskId: options.taskId,
            metadata: {
              signal,
              reasonCode: 'signal_interrupt',
            },
          }
        );
        // IMPORTANT: process.exit() intentionally bypasses the normal cleanup
        // flow. The finally-block at the end of the step loop (acpRunner.close())
        // will NOT run. This is acceptable because:
        //   1. acpRunner.close() is called synchronously right here
        //   2. Signal handlers must exit quickly to avoid hanging
        //   3. Checkpoint data has already been saved above
        // If future cleanup is added to the finally block, ensure it is also
        // called here or converted to a process 'exit' event handler.
        acpRunner?.close();
        // Force-kill after a short grace period in case the agent process
        // ignores SIGTERM (close() sends SIGTERM but doesn't wait).
        // Exit as PAUSED only if checkpoint was saved, otherwise exit as
        // FAILED so the CLI layer doesn't schedule a resume with no checkpoint.
        const exitCode = saved ? EXIT_PAUSED : EXIT_FAILED;
        process.exit(exitCode);
      };
      sigtermHandler = () => gracefulShutdown('SIGTERM');
      sigintHandler = () => gracefulShutdown('SIGINT');
      process.on('SIGTERM', sigtermHandler);
      process.on('SIGINT', sigintHandler);

      // Print Steps
      showList(
        workflowManager.steps.map((step, idx) => `${idx}. ${step.name}`),
        { title: colors.bold('Steps'), addLineBreak: true }
      );

      const totalSteps = WorkflowManager.countSteps(workflowManager.steps);

      // Log workflow start
      logger?.info(
        'workflow_start',
        `Starting workflow: ${workflowManager.name}`,
        {
          taskId: options.taskId,
          metadata: {
            workflowName: workflowManager.name,
            totalSteps,
          },
        }
      );

      // Determine which tool to use.
      // Priority: CLI flag > workflow defaults > fallback to claude.
      const tool =
        options.agentTool || workflowManager.defaults?.tool || 'claude';
      resolvedAgentTool = tool;

      // ACP usage decision: use ACP mode only for tools with ACP support.
      // Set ROVER_NO_ACP=1 to force direct runner mode (bypasses ACP auth issues).
      const acpDisabled = process.env.ROVER_NO_ACP === '1' || process.env.ROVER_NO_ACP === 'true';
      const acpEnabledTools = [
        'claude',
        'gemini',
        'copilot',
        'opencode',
        'qwen',
      ];
      const useACPMode = !acpDisabled && acpEnabledTools.includes(tool.toLowerCase());

      // Build the agent step executor based on mode
      if (useACPMode) {
        console.log(colors.cyan('\n🔗 ACP Mode enabled'));
        const mcpServers = loadMcpServersFromProject(process.cwd());
        mcpServers.push({
          type: 'http' as const,
          name: 'package-manager',
          url: 'http://127.0.0.1:8090/mcp',
          headers: [],
        });

        acpRunner = new ACPRunner({
          workflow: workflowManager,
          inputs,
          defaultTool: options.agentTool,
          defaultModel: options.agentModel,
          statusManager,
          outputDir: options.output,
          logger,
          mcpServers,
        });
      }

      if (acpRunner) {
        await acpRunner.initializeConnection();
        // Defensive: verify connection was actually established. If
        // initializeConnection() resolved without throwing but
        // something went wrong, fail fast rather than dispatching
        // steps to a broken connection.
        if (!acpRunner.isReady()) {
          throw new Error(
            'ACP connection initialization returned but connection is not ready'
          );
        }
      }

      const pauseRequestFile = join(options.output, '.pause-requested');

      const runStepImpl = async (
        step: WorkflowStep,
        stepIndex: number,
        stepsOutput: Map<string, Map<string, string>>
      ): Promise<StepResult> => {
        if (shuttingDown) {
          throw new PauseWorkflowError(
            'Workflow interrupted by shutdown signal'
          );
        }

        // Check for external pause request (written by `rover pause`).
        // This check runs between steps so the current step finishes
        // cleanly before the workflow pauses.
        if (existsSync(pauseRequestFile)) {
          const reason = (() => {
            try {
              return readFileSync(pauseRequestFile, 'utf-8').trim() || 'Paused by external request';
            } catch {
              return 'Paused by external request';
            }
          })();
          statusManager?.pause(step.name, reason);
          throw new PauseWorkflowError(reason);
        }

        const cached = getCachedStepResult(checkpointStore, step, stepsOutput);
        if (cached) return cached;

        return executeStep(step, {
          workflow: workflowManager,
          inputs,
          stepsOutput,
          defaultTool: tool,
          defaultModel: options.agentModel,
          statusManager,
          totalSteps,
          currentStepIndex: stepIndex,
          logger,
          output: options.output,
          acpRunner,
          checkpointStore,
        });
      };

      const runner: WorkflowRunner = {
        runAgentStep: runStepImpl,
        runStep: runStepImpl,
      };

      const onStepComplete: OnStepComplete = (step, result, context) => {
        if (result.success && checkpointStore) {
          // Use addCompletedStep for direct in-place upsert (avoids
          // double-copy overhead of getData() + setCompletedSteps()).
          checkpointStore.addCompletedStep(
            step.id,
            Object.fromEntries(result.outputs.entries())
          );

          if (isLoopStep(step)) {
            checkpointStore.setLoopSignature(
              step.id,
              computeLoopSignature(step)
            );
            for (const subStepId of step.steps.flatMap(
              (subStep: WorkflowStep) => collectNestedStepIds(subStep)
            )) {
              const subStepOutputs = context.stepsOutput.get(subStepId);
              if (!subStepOutputs) continue;
              checkpointStore.addCompletedStep(
                subStepId,
                Object.fromEntries(subStepOutputs.entries())
              );
            }
          }

          // Persist checkpoint to disk after each step so a SIGTERM/SIGINT
          // arriving between steps never loses the just-completed work.
          checkpointStore.persist();
        }

        displayStepResults(step.name, result);
      };

      try {
        const runResult = await workflowManager.run(runner, onStepComplete);

        totalDuration = runResult.totalDuration;

        // Display workflow completion summary
        const successfulSteps = runResult.stepResults.filter(
          r => r.success
        ).length;
        const failedSteps = runResult.stepResults.filter(
          r => !r.success
        ).length;
        const skippedSteps = workflowManager.steps.length - runResult.runSteps;

        let status = colors.green('✓ Workflow Completed Successfully');
        if (failedSteps > 0) {
          status = colors.red('✗ Workflow Completed with Errors');
        } else if (skippedSteps > 0) {
          status =
            colors.green('✓ Workflow Completed Successfully ') +
            colors.yellow('(Some steps were skipped)');
        }

        showTitle('🎉 Workflow Execution Summary');
        // Counts reflect top-level steps only; loop sub-step iterations
        // are not included in these totals.
        showProperties({
          Duration: colors.cyan(runResult.totalDuration.toFixed(2) + 's'),
          'Total Steps': colors.cyan(workflowManager.steps.length.toString()),
          'Successful Steps': colors.green(successfulSteps.toString()),
          'Failed Steps': colors.red(failedSteps.toString()),
          'Skipped Steps': colors.yellow(skippedSteps.toString()),
          Status: status,
        });

        // Mark workflow as completed in status file
        if (failedSteps > 0) {
          output.success = false;
          output.error = runResult.error;
          logger?.error('workflow_fail', 'Workflow completed with errors', {
            taskId: options.taskId,
            duration: runResult.totalDuration,
            metadata: {
              successfulSteps,
              failedSteps,
              skippedSteps,
              reasonCode: workflowReasonCode(runResult.error),
            },
          });
        } else {
          output.success = true;
          clearCheckpointFile(options.output);
          statusManager?.complete('Workflow completed successfully');
          logger?.info('workflow_complete', 'Workflow completed successfully', {
            taskId: options.taskId,
            duration: runResult.totalDuration,
            metadata: {
              successfulSteps,
              failedSteps: 0,
              skippedSteps,
            },
          });
        }
      } catch (err) {
        if (err instanceof PauseWorkflowError) {
          // Already handled: output.paused is set, statusManager.pause() called
          output.success = false;
          output.error = err.message;
          output.paused = true;
          // Capture external repository state into the store before persisting
          // so resume can restore the correct branch/commit positions.
          try {
            const repositories = captureExternalRepositoryStates();
            checkpointStore.setExternalRepositories(
              repositories.length > 0 ? repositories : undefined
            );
          } catch (captureErr) {
            console.warn(
              colors.yellow(
                `⚠ Failed to capture repository state on pause: ${captureErr instanceof Error ? captureErr.message : String(captureErr)}`
              )
            );
          }
          // Ensure checkpoint is persisted even if saveFailureSnapshot's
          // internal persist() failed earlier (it warns but continues).
          checkpointStore.persist();
          logger?.info('workflow_pause', output.error, {
            taskId: options.taskId,
            metadata: {
              reason: 'retryable_error',
              reasonCode: 'retryable_error',
            },
          });
        } else {
          throw err;
        }
      } finally {
        // Always close the ACP runner after all steps are complete
        acpRunner?.close();
      }
    }
  } catch (err) {
    output.success = false;
    output.error = err instanceof Error ? err.message : `${err}`;
  }

  if (!output.success) {
    if (output.paused) {
      // Already handled by statusManager.pause() - don't overwrite with fail()
      if (!shutdownSignal) {
        console.log(colors.yellow(`\n⏸ ${output.error}`));
      }
    } else {
      statusManager?.fail(
        'Workflow execution',
        output.error || 'Unknown error'
      );
      logger?.error('workflow_fail', output.error || 'Unknown error', {
        taskId: options.taskId,
        error: output.error,
        duration: totalDuration,
        metadata: {
          reasonCode: workflowReasonCode(output.error),
        },
      });

      console.log(colors.red(`\n✗ ${output.error}`));
    }
  }

  // Collect agent-specific logs into the logs directory
  if (logsDir) {
    collectAgentLogs(logsDir, resolvedAgentTool);
  }

  // Signal handlers are removed in gracefulShutdown() on first signal.
  // Clean up here only for the non-signal exit path (the guard in
  // gracefulShutdown ensures this is a no-op when already removed).
  if (!shutdownSignal) {
    if (sigtermHandler) process.off('SIGTERM', sigtermHandler);
    if (sigintHandler) process.off('SIGINT', sigintHandler);
  }

  process.exit(
    output.success ? EXIT_SUCCESS : output.paused ? EXIT_PAUSED : EXIT_FAILED
  );
};
