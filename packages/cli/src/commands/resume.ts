import colors from 'ansi-colors';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { generateBranchName } from '../utils/branch-name.js';
import {
  UserSettingsManager,
  IterationManager,
  AI_AGENT,
  Git,
  ProjectConfigManager,
  type ProjectManager,
} from 'rover-core';
import { TaskNotFoundError } from 'rover-schemas';
import { exitWithError, exitWithSuccess } from '../utils/exit.js';
import { createSandbox } from '../lib/sandbox/index.js';
import type { CLIJsonOutput } from '../types.js';
import { getTelemetry } from '../lib/telemetry.js';
import {
  isJsonMode,
  setJsonMode,
  requireProjectContext,
} from '../lib/context.js';
import yoctoSpinner from 'yocto-spinner';
import { copyEnvironmentFiles } from '../utils/env-files.js';
import type { CommandDefinition } from '../types.js';

/**
 * Interface for JSON output
 */
interface TaskResumeOutput extends CLIJsonOutput {
  taskId?: number;
  title?: string;
  description?: string;
  status?: string;
  resumedAt?: string;
}

/**
 * Resume a task that is in PAUSED or FAILED status.
 *
 * Resumes a task that was paused due to credit limit exhaustion or other
 * retryable errors. Reuses the existing iteration directory and worktree,
 * and mounts the checkpoint.json file so the agent can skip completed steps.
 * Falls back to full restart behavior if no checkpoint is found.
 *
 * @param taskId - The numeric task ID to resume
 * @param options - Command options
 * @param options.json - Output results in JSON format
 */
const resumeCommand = async (
  taskId: string,
  options: { json?: boolean } = {}
) => {
  if (options.json !== undefined) {
    setJsonMode(options.json);
  }

  const telemetry = getTelemetry();

  const json = options.json === true;
  let jsonOutput: TaskResumeOutput = {
    success: false,
  };

  // Convert string taskId to number
  const numericTaskId = parseInt(taskId, 10);
  if (isNaN(numericTaskId)) {
    jsonOutput.error = `Invalid task ID '${taskId}' - must be a number`;
    await exitWithError(jsonOutput, { telemetry });
    return;
  }

  // Require project context
  let project;
  try {
    project = await requireProjectContext();
  } catch (error) {
    jsonOutput.error = error instanceof Error ? error.message : String(error);
    await exitWithError(jsonOutput, { telemetry });
    return;
  }

  try {
    // Load task using ProjectManager
    const task = project.getTask(numericTaskId);
    if (!task) {
      throw new TaskNotFoundError(numericTaskId);
    }

    // Check if task is in PAUSED or FAILED status
    if (!task.isPaused() && !task.isFailed()) {
      jsonOutput.error = `Task ${taskId} is not in PAUSED or FAILED status (current: ${task.status})`;
      await exitWithError(jsonOutput, {
        tips: [
          'Only PAUSED and FAILED tasks can be resumed',
          'Use ' +
            colors.cyan(`rover inspect ${taskId}`) +
            colors.gray(' to find out the current task status'),
        ],
        telemetry,
      });
      return;
    }

    // Find checkpoint.json in the last iteration's output directory
    const iterationPath = join(
      task.iterationsPath(),
      task.iterations.toString()
    );
    const checkpointPath = join(iterationPath, 'checkpoint.json');
    const hasCheckpoint = existsSync(checkpointPath);

    if (!hasCheckpoint && !isJsonMode()) {
      console.log(
        colors.yellow(
          '⚠ No checkpoint found - will run full workflow from start'
        )
      );
    }

    // Ensure worktree exists and is valid
    let worktreePath = task.worktreePath;
    let branchName = task.branchName;

    if (!worktreePath || !branchName) {
      worktreePath = project.getWorkspacePath(numericTaskId);
      branchName = generateBranchName(numericTaskId);

      const spinner = !json
        ? yoctoSpinner({ text: 'Setting up workspace...' }).start()
        : null;

      try {
        const git = new Git({ cwd: project.path });
        git.createWorktree(worktreePath, branchName);

        // Copy user .env development files
        copyEnvironmentFiles(project.path, worktreePath);

        // Configure sparse checkout to exclude files matching exclude patterns
        const projectConfig = ProjectConfigManager.load(project.path);
        if (
          projectConfig.excludePatterns &&
          projectConfig.excludePatterns.length > 0
        ) {
          git.setupSparseCheckout(worktreePath, projectConfig.excludePatterns);
        }

        // Update task with workspace information
        task.setWorkspace(worktreePath, branchName);

        if (spinner) spinner.success('Workspace setup complete');
      } catch (error) {}
    }

    // Ensure iterations directory exists
    mkdirSync(iterationPath, { recursive: true });

    // Create initial iteration.json if it doesn't exist
    const iterationJsonPath = join(iterationPath, 'iteration.json');
    if (!existsSync(iterationJsonPath)) {
      IterationManager.createInitial(
        iterationPath,
        task.id,
        task.title,
        task.description
      );
    }

    const resumedAt = new Date().toISOString();

    if (!isJsonMode()) {
      console.log(colors.bold('Resuming Task'));
      console.log(colors.gray('├── ID: ') + colors.cyan(task.id.toString()));
      console.log(colors.gray('├── Title: ') + task.title);
      console.log(colors.gray('├── Status: ') + colors.yellow(task.status));
      console.log(colors.gray('├── Workspace: ') + colors.cyan(worktreePath));
      console.log(colors.gray('├── Branch: ') + colors.cyan(branchName));
      console.log(
        colors.gray('├── Checkpoint: ') +
          (hasCheckpoint ? colors.green('found') : colors.yellow('not found'))
      );
      if (process.env.ROVER_AGENT_IMAGE) {
        console.log(
          colors.gray('├── Agent Image: ') +
            colors.cyan(process.env.ROVER_AGENT_IMAGE)
        );
      }
      console.log(
        colors.gray('└── Resuming to: ') + colors.yellow('IN_PROGRESS')
      );
      console.log('');
    }

    // Mark task as in progress
    task.markInProgress();

    // Track resume event (reuse restart telemetry)
    telemetry?.eventRestartTask();

    // Check if user provided a custom agent image via environment variable
    if (process.env.ROVER_AGENT_IMAGE) {
      task.setAgentImage(process.env.ROVER_AGENT_IMAGE);
    }

    // Start sandbox container for task execution
    try {
      const sandbox = await createSandbox(task, undefined, {
        projectPath: project.path,
        checkpointPath: hasCheckpoint ? checkpointPath : undefined,
      });
      const containerId = await sandbox.createAndStart();

      // Update task metadata with new container ID
      task.setContainerInfo(
        containerId,
        'running',
        process.env.DOCKER_HOST
          ? { dockerHost: process.env.DOCKER_HOST }
          : undefined
      );
    } catch (error) {
      // If sandbox execution fails, reset task back to PAUSED/FAILED status
      task.markPaused('Resume failed: container could not start');
      throw error;
    }

    // Output final JSON after all operations are complete
    jsonOutput = {
      ...jsonOutput,
      success: true,
      taskId: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      resumedAt,
    };

    await exitWithSuccess('Task resumed successfully!', jsonOutput, {
      tips: [
        'Use ' + colors.cyan('rover list') + ' to check the list of tasks',
        'Use ' +
          colors.cyan(`rover logs -f ${task.id}`) +
          ' to watch the task logs',
        'Use ' +
          colors.cyan(`rover inspect ${task.id}`) +
          ' to check the task status',
      ],
      telemetry,
    });

    return;
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      jsonOutput.error = `The task with ID ${numericTaskId} was not found`;
      await exitWithError(jsonOutput, { telemetry });
      return;
    } else {
      jsonOutput.error = `There was an error resuming the task: ${error}`;
      await exitWithError(jsonOutput, { telemetry });
      return;
    }
  } finally {
    await telemetry?.shutdown();
  }
};

// Named export for backwards compatibility (used by tests)
export { resumeCommand };

export default {
  name: 'resume',
  description: 'Resume a paused or failed task from checkpoint',
  requireProject: true,
  action: resumeCommand,
} satisfies CommandDefinition;
