import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { generateBranchName } from '../utils/branch-name.js';
import {
  IterationManager,
  Git,
  ProjectConfigManager,
  type ProjectManager,
} from 'rover-core';
import { TaskNotFoundError } from 'rover-schemas';
import { createSandbox } from '../lib/sandbox/index.js';
import { copyEnvironmentFiles } from '../utils/env-files.js';

/**
 * Core resume logic extracted for reuse by both the `resume` command
 * and the automatic RetryScheduler.
 *
 * @returns true if the sandbox was started successfully, false otherwise.
 */
export async function resumeTask(
  project: ProjectManager,
  taskId: number
): Promise<boolean> {
  const task = project.getTask(taskId);
  if (!task) {
    throw new TaskNotFoundError(taskId);
  }

  // Only PAUSED or FAILED tasks can be resumed
  if (!task.isPaused() && !task.isFailed()) {
    return false;
  }

  // Find checkpoint.json in the last iteration's output directory
  const iterationPath = join(task.iterationsPath(), task.iterations.toString());
  const checkpointPath = join(iterationPath, 'checkpoint.json');
  const hasCheckpoint = existsSync(checkpointPath);

  // Ensure worktree exists and is valid
  let worktreePath = task.worktreePath;
  let branchName = task.branchName;

  if (!worktreePath || !branchName) {
    worktreePath = project.getWorkspacePath(taskId);
    branchName = generateBranchName(taskId);

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
    } catch {
      return false;
    }
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

  // Mark task as in progress
  task.markInProgress();

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

    return true;
  } catch {
    // If sandbox execution fails, reset task back to PAUSED status
    task.markPaused('Resume failed: container could not start');
    return false;
  }
}
