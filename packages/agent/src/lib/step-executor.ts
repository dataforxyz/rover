/**
 * Unified step dispatcher for workflow execution.
 * Routes steps to the appropriate executor based on step type:
 *   - agent -> Runner
 *   - command -> CommandRunner
 *   - loop -> iterative sub-step execution
 */

import colors from 'ansi-colors';
import { createHash } from 'node:crypto';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  WorkflowManager,
  type IterationStatusManager,
  type JsonlLogger,
} from 'rover-core';
import {
  isAgentStep,
  isCommandStep,
  isLoopStep,
  type WorkflowStep,
  type WorkflowLoopStep,
} from 'rover-schemas';
import { Runner, type RunnerStepResult } from './runner.js';
import { runCommandStep, type CommandStepResult } from './command-runner.js';
import { evaluateCondition } from './condition.js';
import type { ACPRunner, ACPRunnerStepResult } from './acp-runner.js';
import type {
  CheckpointLoopProgress,
  CheckpointStore,
} from './checkpoint-store.js';

export interface StepExecutorConfig {
  workflow: WorkflowManager;
  inputs: Map<string, string>;
  stepsOutput: Map<string, Map<string, string>>;
  defaultTool?: string;
  defaultModel?: string;
  statusManager?: IterationStatusManager;
  totalSteps: number;
  currentStepIndex: number;
  logger?: JsonlLogger;
  output?: string;
  acpRunner?: ACPRunner;
  reuseAcpSession?: boolean;
  checkpointStore?: CheckpointStore;
}

export type StepResult =
  | RunnerStepResult
  | CommandStepResult
  | ACPRunnerStepResult;

const DEFAULT_MAX_ITERATIONS = 3;
const MAX_TRANSIENT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 10_000;
/** Sentinel value set in stepsOutput for conditionally skipped steps. */
const SKIPPED_SENTINEL_KEY = '__skipped__';

export class PauseWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PauseWorkflowError';
  }
}

export function isTransientError(errorMsg: string): boolean {
  return /ECONNREFUSED|ETIMEDOUT|ENETUNREACH|network[_\s-]error|connection[_\s-](failed|refused|reset)|too[_\s-]many[_\s-]requests|\b429\b|\b5(?:00|02|03|04|29)\b|internal[_\s-]server[_\s-]error|service[_\s-]unavailable|temporar(?:ily)?[_\s-](?:unavailable|overloaded)|overloaded[_\s-]error|server[_\s-]error/i.test(
    errorMsg
  );
}

export function isRetryableError(
  errorMsg: string,
  errorRetryableFlag?: string
): boolean {
  if (errorRetryableFlag === 'true') return true;
  if (errorRetryableFlag === 'false') return false;
  if (isTransientError(errorMsg)) return true;
  if (isAuthError(errorMsg)) return true;
  return /rate[_\s-]limit|credit[_\s-](limit|exhaust)|billing[_\s-](limit|error)|quota[_\s-](exhaust|exceeded|limit)|hit your limit|usage limit|plan limit|connection[_\s-]timeout|authentication[_\s-](required|error|failed)|invalid[_\s-](api[_\s-]key|bearer[_\s-]token|credentials)|\b401\b.*unauthori[sz]ed/i.test(
    errorMsg
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Detect authentication errors (expired tokens, invalid credentials)
 * as distinct from usage/rate-limit errors.
 */
export function isAuthError(errorMsg: string): boolean {
  return /authentication[_\s-]error|oauth[_\s]token[_\s]has[_\s]expired|invalid[_\s-]bearer[_\s-]token|\b401\b|unauthorized|token[_\s]expired|does not have access.*login|please login again/i.test(
    errorMsg
  );
}

/**
 * Re-copy credentials from bind-mount source (/) to $HOME.
 * Container entrypoint mounts host credentials read-only at /;
 * rover-agent-install copies them to $HOME once at startup.
 * If the host token refreshed mid-run, this picks up the new one.
 *
 * Returns true if any credentials were refreshed.
 */
function refreshCredentials(): boolean {
  const home = process.env.HOME || '/home/agent';
  let refreshed = false;

  // Claude: /.credentials.json -> $HOME/.claude/.credentials.json
  const claudeSrc = '/.credentials.json';
  const claudeDir = join(home, '.claude');
  const claudeDst = join(claudeDir, '.credentials.json');
  if (existsSync(claudeSrc)) {
    try {
      mkdirSync(claudeDir, { recursive: true });
      copyFileSync(claudeSrc, claudeDst);
      refreshed = true;
    } catch {
      // best-effort
    }
  }

  // Codex: /.codex/auth.json -> $HOME/.codex/auth.json
  const codexSrc = '/.codex/auth.json';
  const codexDir = join(home, '.codex');
  const codexDst = join(codexDir, 'auth.json');
  if (existsSync(codexSrc)) {
    try {
      mkdirSync(codexDir, { recursive: true });
      copyFileSync(codexSrc, codexDst);
      refreshed = true;
    } catch {
      // best-effort
    }
  }

  // Codex config.toml
  const codexCfgSrc = '/.codex/config.toml';
  const codexCfgDst = join(codexDir, 'config.toml');
  if (existsSync(codexCfgSrc)) {
    try {
      copyFileSync(codexCfgSrc, codexCfgDst);
    } catch {
      // best-effort
    }
  }

  return refreshed;
}

export interface StepTreeNode {
  id: string;
  steps?: StepTreeNode[];
  then?: StepTreeNode[];
  else?: StepTreeNode[];
}

export function collectNestedStepIds(step: StepTreeNode): string[] {
  return [
    step.id,
    ...(step.steps?.flatMap(collectNestedStepIds) ?? []),
    ...(step.then?.flatMap(collectNestedStepIds) ?? []),
    ...(step.else?.flatMap(collectNestedStepIds) ?? []),
  ];
}

function clearStepOutputs(
  step: StepTreeNode,
  stepsOutput: Map<string, Map<string, string>>
): void {
  for (const stepId of collectNestedStepIds(step)) {
    stepsOutput.delete(stepId);
  }
}

function findNestedStepById(
  steps: WorkflowStep[],
  stepId: string
): WorkflowStep | undefined {
  for (const step of steps) {
    if (step.id === stepId) {
      return step;
    }
    if (isLoopStep(step)) {
      const nestedStep = findNestedStepById(step.steps, stepId);
      if (nestedStep) {
        return nestedStep;
      }
    }
  }
  return undefined;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableSerialize(entryValue)}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeLoopSignature(loopStep: WorkflowLoopStep): string {
  // Hash only structural properties so renaming a loop step without
  // changing its logic doesn't invalidate checkpoint progress.
  const structural = {
    steps: loopStep.steps,
    until: loopStep.until,
    maxIterations: loopStep.maxIterations,
  };
  return createHash('sha256').update(stableSerialize(structural)).digest('hex');
}

function snapshotLoopSubStepOutputs(
  loopStep: WorkflowLoopStep,
  stepsOutput: Map<string, Map<string, string>>
): Record<string, Record<string, string>> {
  const subStepOutputs: Record<string, Record<string, string>> = {};

  for (const stepId of loopStep.steps.flatMap((step: WorkflowStep) =>
    collectNestedStepIds(step)
  )) {
    const outputs = stepsOutput.get(stepId);
    if (!outputs || outputs.size === 0) continue;
    subStepOutputs[stepId] = Object.fromEntries(outputs);
  }

  return subStepOutputs;
}

function persistLoopProgress(
  loopStep: WorkflowLoopStep,
  config: StepExecutorConfig,
  iteration: number,
  nextSubStepIndex: number,
  skippedSubSteps: Set<string>,
  flush = false
): void {
  config.checkpointStore?.setLoopSignature(
    loopStep.id,
    computeLoopSignature(loopStep)
  );
  config.checkpointStore?.setLoopProgress(loopStep.id, {
    iteration,
    nextSubStepIndex,
    subStepOutputs: snapshotLoopSubStepOutputs(loopStep, config.stepsOutput),
    skippedSubSteps: Array.from(skippedSubSteps),
  });
  // Only flush to disk when explicitly requested (iteration boundaries).
  // Mid-iteration calls only update in-memory state so that a pause/error
  // mid-iteration still captures the latest sub-step progress without
  // causing excessive disk I/O on every individual sub-step.
  if (flush) {
    config.checkpointStore?.persist();
  }
}

function restoreLoopProgress(
  loopStep: WorkflowLoopStep,
  config: StepExecutorConfig,
  progress: CheckpointLoopProgress
): boolean {
  const knownStepIds = new Set(
    loopStep.steps.flatMap((step: WorkflowStep) => collectNestedStepIds(step))
  );

  for (const [stepId, outputs] of Object.entries(progress.subStepOutputs)) {
    if (!knownStepIds.has(stepId)) continue;
    config.stepsOutput.set(stepId, new Map(Object.entries(outputs)));
  }

  for (const stepId of progress.skippedSubSteps) {
    if (!knownStepIds.has(stepId)) continue;
    const skippedStep = findNestedStepById(loopStep.steps, stepId);
    if (skippedStep) {
      clearStepOutputs(skippedStep, config.stepsOutput);
    }
    const skippedOutputs = new Map<string, string>();
    skippedOutputs.set(SKIPPED_SENTINEL_KEY, 'true');
    config.stepsOutput.set(stepId, skippedOutputs);
  }

  return (
    progress.iteration > 0 &&
    progress.nextSubStepIndex >= 0 &&
    progress.nextSubStepIndex <= loopStep.steps.length
  );
}

export function shouldSkipStep(
  step: WorkflowStep,
  stepsOutput: Map<string, Map<string, string>>
): boolean {
  if (!step.if) return false;
  return !evaluateCondition(step.if, stepsOutput);
}

export async function executeStep(
  step: WorkflowStep,
  config: StepExecutorConfig
): Promise<StepResult> {
  if (isAgentStep(step)) {
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      let result: StepResult;

      if (config.acpRunner) {
        const acpRunner = config.acpRunner;
        const managesSessionLifecycle = !config.reuseAcpSession;
        let sessionClosed = false;
        if (managesSessionLifecycle) {
          await acpRunner.createSession();
        }

        for (const [stepId, outputs] of config.stepsOutput.entries()) {
          acpRunner.stepsOutput.set(stepId, outputs);
        }

        try {
          result = await acpRunner.runStep(step.id);
        } catch (err) {
          // Treat thrown ACP errors like failed results for transient retry.
          // Without this, thrown exceptions (e.g. JSON-RPC connection errors)
          // would bypass the retry loop entirely.
          const errorMsg = err instanceof Error ? err.message : String(err);
          if (isAuthError(errorMsg) && attempt < MAX_TRANSIENT_RETRIES) {
            const didRefresh = refreshCredentials();
            acpRunner.closeSession();
            sessionClosed = true;
            if (!managesSessionLifecycle) {
              await acpRunner.createSession();
              sessionClosed = false;
            }
            const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
            console.log(
              colors.yellow(
                `\n⚠ ACP authentication error.${didRefresh ? ' Credentials refreshed from host.' : ''} Retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES})...`
              )
            );
            await sleep(delayMs);
            continue;
          }
          if (isTransientError(errorMsg) && attempt < MAX_TRANSIENT_RETRIES) {
            acpRunner.closeSession();
            sessionClosed = true;
            if (!managesSessionLifecycle) {
              await acpRunner.createSession();
              sessionClosed = false;
            }
            const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
            console.log(
              colors.yellow(
                `\n⚠ Transient ACP error detected. Retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES})...`
              )
            );
            await sleep(delayMs);
            continue;
          }
          acpRunner.closeSession();
          sessionClosed = true;
          // Convert thrown ACP errors into a failed StepResult so they flow
          // through the retryable/pause logic below instead of bubbling up
          // as an unhandled exception (which causes FAILED instead of PAUSED).
          result = {
            id: step.id,
            success: false,
            error: errorMsg,
            duration: 0,
            outputs: new Map([
              ['error', errorMsg],
              ['error_code', 'ACP_ERROR'],
              ['error_retryable', String(isRetryableError(errorMsg))],
            ]),
          };
        }

        if (managesSessionLifecycle && !sessionClosed) {
          acpRunner.closeSession();
        }
      } else {
        const runner = new Runner(
          config.workflow,
          step.id,
          config.inputs,
          config.stepsOutput,
          config.defaultTool,
          config.defaultModel,
          config.statusManager,
          config.totalSteps,
          config.currentStepIndex,
          config.logger
        );
        result = await runner.run(config.output);
      }

      if (result.success) {
        return result;
      }

      const errorMsg = result.error || '';

      // Auth errors: refresh credentials from bind mount and retry
      if (isAuthError(errorMsg) && attempt < MAX_TRANSIENT_RETRIES) {
        const didRefresh = refreshCredentials();
        const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(
          colors.yellow(
            `\n⚠ Authentication error detected.${didRefresh ? ' Credentials refreshed from host.' : ''} Retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES})...`
          )
        );
        await sleep(delayMs);
        continue;
      }

      if (isTransientError(errorMsg) && attempt < MAX_TRANSIENT_RETRIES) {
        const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(
          colors.yellow(
            `\n⚠ Transient error detected. Retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES})...`
          )
        );
        await sleep(delayMs);
        continue;
      }

      const retryable = isRetryableError(
        errorMsg,
        result.outputs?.get('error_retryable')
      );
      const provider =
        step.tool ||
        config.defaultTool ||
        config.workflow.defaults?.tool ||
        'claude';

      const completedSteps =
        config.checkpointStore?.getData().completedSteps ?? [];

      const checkpointSaved = config.checkpointStore?.saveFailureSnapshot({
        completedSteps,
        failedStepId: step.id,
        error: result.error,
        isRetryable: retryable,
        provider,
      });

      if (retryable) {
        if (checkpointSaved === false || checkpointSaved === undefined) {
          // Checkpoint store missing or save failed — return the failed result
          // instead of pausing, so the caller exits as FAILED rather than
          // PAUSED with no checkpoint to resume from.
          return result;
        }
        config.statusManager?.pause(
          step.name,
          result.error || 'Usage limit reached',
          provider
        );
        throw new PauseWorkflowError(
          `Workflow paused due to retryable error: ${result.error}`
        );
      }

      return result;
    }

    throw new Error('Unexpected: retry loop exited without returning');
  }

  if (isCommandStep(step)) {
    const timeout = config.workflow.getStepTimeout(step.id);
    return runCommandStep(step, config.inputs, config.stepsOutput, timeout);
  }

  if (isLoopStep(step)) {
    return executeLoopStep(step, config);
  }

  throw new Error(`Unsupported step type: ${(step as any).type}`);
}

async function executeLoopStep(
  loopStep: WorkflowLoopStep,
  config: StepExecutorConfig
): Promise<StepResult> {
  const start = performance.now();
  const workflowLoopLimit = config.workflow.config?.loopLimit;
  const stepMax = loopStep.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxIterations =
    workflowLoopLimit != null ? Math.min(stepMax, workflowLoopLimit) : stepMax;
  const managesSessionLifecycle =
    Boolean(config.acpRunner) && !config.reuseAcpSession;
  let conditionMet = false;
  let lastIteration = 0;
  let lastError: string | undefined;
  let failedSubStep = false;
  const checkpointProgress = config.checkpointStore?.getLoopProgress(
    loopStep.id
  );
  let startIteration = 1;
  let resumeSubStepIndex = 0;
  let skippedSubSteps = new Set<string>();
  let hasLoopAcpSession = false;

  if (checkpointProgress) {
    const validProgress = restoreLoopProgress(
      loopStep,
      config,
      checkpointProgress
    );
    if (validProgress) {
      startIteration = checkpointProgress.iteration;
      resumeSubStepIndex = checkpointProgress.nextSubStepIndex;
      skippedSubSteps = new Set(checkpointProgress.skippedSubSteps);

      // Also verify the loop signature hasn't changed (workflow edit
      // between pause and resume) — stale progress should not be restored.
      const savedSig =
        config.checkpointStore?.getData()?.loopSignatures?.[loopStep.id];
      const currentSig = computeLoopSignature(loopStep);
      if (
        startIteration > maxIterations ||
        (savedSig && savedSig !== currentSig)
      ) {
        const reason =
          startIteration > maxIterations
            ? `Checkpoint iteration ${startIteration} exceeds maxIterations ${maxIterations}`
            : 'Loop definition changed since checkpoint was saved';
        console.log(
          colors.yellow(`  ⚠ ${reason} — restarting loop "${loopStep.name}"`)
        );
        startIteration = 1;
        resumeSubStepIndex = 0;
        skippedSubSteps = new Set<string>();
        // Clear restored sub-step outputs so stale data doesn't leak.
        // Also clear outputs for any step IDs from the OLD loop definition
        // stored in checkpoint data, which may differ from the NEW definition.
        for (const stepId of Object.keys(
          checkpointProgress.subStepOutputs ?? {}
        )) {
          config.stepsOutput.delete(stepId);
        }
        for (const stepId of loopStep.steps.flatMap((s: WorkflowStep) =>
          collectNestedStepIds(s)
        )) {
          config.stepsOutput.delete(stepId);
        }
        config.checkpointStore?.clearLoopProgress(loopStep.id);
      } else {
        const resumePointLabel =
          resumeSubStepIndex === loopStep.steps.length
            ? 'pending until check'
            : `sub-step ${resumeSubStepIndex + 1}`;
        console.log(
          colors.cyan(
            `  ↺ Resuming loop "${loopStep.name}" at iteration ${startIteration}, ${resumePointLabel}`
          )
        );
      }
    } else {
      console.log(
        colors.yellow(
          `  ⚠ Ignoring invalid checkpoint state for loop "${loopStep.name}"`
        )
      );
      // Clear restored sub-step outputs so stale data doesn't leak.
      // Also clear outputs for any step IDs from the OLD loop definition
      // stored in checkpoint data, which may differ from the NEW definition.
      for (const stepId of Object.keys(
        checkpointProgress.subStepOutputs ?? {}
      )) {
        config.stepsOutput.delete(stepId);
      }
      for (const stepId of loopStep.steps.flatMap((s: WorkflowStep) =>
        collectNestedStepIds(s)
      )) {
        config.stepsOutput.delete(stepId);
      }
      config.checkpointStore?.clearLoopProgress(loopStep.id);
    }
  }

  console.log(
    colors.blue(
      `\n🔄 Starting loop "${loopStep.name}" (max ${maxIterations} iterations, until: ${loopStep.until})`
    )
  );

  try {
    if (managesSessionLifecycle && config.acpRunner) {
      await config.acpRunner.createSession();
      hasLoopAcpSession = true;
    }

    for (
      let iteration = startIteration;
      iteration <= maxIterations;
      iteration++
    ) {
      lastIteration = iteration;
      console.log(
        colors.cyan(`\n  ↻ Loop iteration ${iteration}/${maxIterations}`)
      );

      const subStepStartIndex =
        iteration === startIteration ? resumeSubStepIndex : 0;
      let subStepFlatIndex =
        config.currentStepIndex +
        WorkflowManager.countSteps(loopStep.steps.slice(0, subStepStartIndex));

      for (
        let subStepIndex = subStepStartIndex;
        subStepIndex < loopStep.steps.length;
        subStepIndex++
      ) {
        const subStep = loopStep.steps[subStepIndex];
        if (shouldSkipStep(subStep, config.stepsOutput)) {
          console.log(
            colors.gray(
              `  ⏭ Skipping step "${subStep.name}" (condition not met)`
            )
          );
          clearStepOutputs(subStep, config.stepsOutput);
          const skippedOutputs = new Map<string, string>();
          skippedOutputs.set(SKIPPED_SENTINEL_KEY, 'true');
          config.stepsOutput.set(subStep.id, skippedOutputs);
          skippedSubSteps.add(subStep.id);
          persistLoopProgress(
            loopStep,
            config,
            iteration,
            subStepIndex + 1,
            skippedSubSteps
          );
          subStepFlatIndex += WorkflowManager.countSteps([subStep]);
          continue;
        }

        const subResult = await executeStep(subStep, {
          ...config,
          currentStepIndex: subStepFlatIndex,
          reuseAcpSession: config.reuseAcpSession || hasLoopAcpSession,
        });

        config.stepsOutput.set(subStep.id, subResult.outputs);
        skippedSubSteps.delete(subStep.id);
        // Flush to disk after each sub-step so that a crash or pause
        // mid-iteration still captures the latest progress. Without this,
        // only in-memory state is updated and a process kill between
        // sub-steps would lose the completed sub-step's outputs.
        persistLoopProgress(
          loopStep,
          config,
          iteration,
          subStepIndex + 1,
          skippedSubSteps,
          true
        );

        if (isCommandStep(subStep)) {
          const exitCode = subResult.outputs.get('exit_code') ?? 'unknown';
          const stdout = subResult.outputs.get('stdout') ?? '';
          const stderr = subResult.outputs.get('stderr') ?? '';

          console.log(
            colors.gray(`  ▸ ${subStep.name} (exit code: ${exitCode})`)
          );
          if (stdout) {
            const lines = stdout.split('\n');
            const display =
              lines.length > 30
                ? [
                    ...lines.slice(0, 5),
                    `  ... (${lines.length - 10} lines) ...`,
                    ...lines.slice(-5),
                  ].join('\n')
                : stdout;
            console.log(colors.gray(display));
          }
          if (stderr && !subResult.success) {
            const errLines = stderr.split('\n');
            const errDisplay =
              errLines.length > 30
                ? [
                    ...errLines.slice(0, 5),
                    `  ... (${errLines.length - 10} lines) ...`,
                    ...errLines.slice(-5),
                  ].join('\n')
                : stderr;
            console.log(colors.yellow(errDisplay));
          }
        }

        if (!subResult.success) {
          lastError = subResult.error;
          console.log(
            colors.yellow(
              `  ⚠ Sub-step "${subStep.id}" failed: ${subResult.error}`
            )
          );

          const continueOnError =
            config.workflow.config?.continueOnError ?? false;
          if (!continueOnError) {
            failedSubStep = true;
            config.checkpointStore?.clearLoopProgress(loopStep.id);
            config.checkpointStore?.persist();
            break;
          }
        }

        subStepFlatIndex += WorkflowManager.countSteps([subStep]);
      }

      if (failedSubStep) {
        break;
      }

      if (evaluateCondition(loopStep.until, config.stepsOutput)) {
        conditionMet = true;
        console.log(colors.green(`  ✓ Loop condition met, exiting loop`));
      }

      if (conditionMet) {
        config.checkpointStore?.clearLoopProgress(loopStep.id);
        config.checkpointStore?.persist();
        break;
      }

      if (iteration < maxIterations) {
        // Flush to disk only at iteration boundaries to reduce I/O overhead.
        persistLoopProgress(
          loopStep,
          config,
          iteration + 1,
          0,
          skippedSubSteps,
          true
        );
      }
    }
  } finally {
    if (hasLoopAcpSession) {
      config.acpRunner?.closeSession();
    }
  }

  const duration = (performance.now() - start) / 1000;
  const outputs = new Map<string, string>();
  outputs.set('iterations', String(lastIteration));
  outputs.set('condition_met', String(conditionMet));

  if (!conditionMet && !failedSubStep) {
    config.checkpointStore?.clearLoopProgress(loopStep.id);
    config.checkpointStore?.persist();
    console.log(
      colors.yellow(
        `  ⚠ Loop "${loopStep.name}" reached max iterations (${maxIterations}) without condition being met`
      )
    );
  }

  return {
    id: loopStep.id,
    success: conditionMet && !failedSubStep,
    error:
      conditionMet && !failedSubStep
        ? undefined
        : lastError ||
          `Loop condition not met after ${maxIterations} iterations`,
    duration,
    outputs,
  };
}
