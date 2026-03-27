import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
} from 'node:fs';
import { generateBranchName } from '../utils/branch-name.js';
import {
  IterationManager,
  IterationStatusManager,
  Git,
  ProjectConfigManager,
  type ProjectManager,
  launchSync,
} from 'rover-core';
import { TaskNotFoundError } from 'rover-schemas';
import { createSandbox } from '../lib/sandbox/index.js';
import { copyEnvironmentFiles } from '../utils/env-files.js';
import {
  isResumeLockActive,
  formatLockContent,
  parseLockContent,
  LOCK_STALENESS_TIMEOUT_MS,
} from '../utils/resume-lock.js';
import { isProcessAlive } from '../utils/process.js';
import colors from 'ansi-colors';

/**
 * Acquire a file-based lock for a task resume operation.
 * Prevents concurrent resume attempts (manual + auto-retry) from racing.
 * Returns a release function, or null if the lock is already held.
 */
export function acquireResumeLock(iterationPath: string): (() => void) | null {
  const lockPath = join(iterationPath, '.resume.lock');
  const reclaimLockPath = `${lockPath}.reclaim`;

  const tryAcquireLock = (): (() => void) | null => {
    try {
      // O_EXCL semantics: writeFileSync with flag 'wx' fails if file exists
      writeFileSync(lockPath, formatLockContent(process.pid), { flag: 'wx' });
      return () => {
        try {
          unlinkSync(lockPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            console.warn(
              `Warning: Failed to release resume lock at ${lockPath}: ${code || (err instanceof Error ? err.message : String(err))}`
            );
          }
        }
      };
    } catch {
      return null;
    }
  };

  const tryAcquireReclaimLock = (): (() => void) | null => {
    try {
      writeFileSync(reclaimLockPath, formatLockContent(process.pid), {
        flag: 'wx',
      });
      return () => {
        try {
          unlinkSync(reclaimLockPath);
        } catch {}
      };
    } catch {
      return null;
    }
  };

  const isPidLockActive = (path: string): boolean => {
    if (!existsSync(path)) {
      return false;
    }

    try {
      const content = readFileSync(path, 'utf8');
      const { pid, createdAt } = parseLockContent(content);
      if (createdAt !== undefined) {
        const age = Date.now() - createdAt;
        if (age >= LOCK_STALENESS_TIMEOUT_MS || age < 0) {
          return false;
        }
      }
      return isProcessAlive(pid);
    } catch {
      return false;
    }
  };

  const release = tryAcquireLock();
  if (release) {
    return release;
  }

  // Lock file already exists — only reclaim if the owning PID is dead.
  // Reuse isResumeLockActive to avoid duplicating PID-checking logic.
  if (isResumeLockActive(iterationPath)) {
    // Lock is held by a live process — do not steal it.
    return null;
  }

  // Serialize stale-lock reclaim attempts so two contenders cannot both
  // unlink/recreate the lock in a race window.
  const releaseReclaimLock = tryAcquireReclaimLock();
  let releaseReclaim = releaseReclaimLock;
  if (!releaseReclaim) {
    // Reclaim lock may itself be stale from a crashed process.
    if (isPidLockActive(reclaimLockPath)) {
      return null;
    }

    try {
      unlinkSync(reclaimLockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return null;
      }
    }

    releaseReclaim = tryAcquireReclaimLock();
    if (!releaseReclaim) {
      return null;
    }

    // Verify we still own the reclaim lock — another process may have
    // also been reclaiming the stale lock and deleted+recreated ours
    // in the TOCTOU window between isPidLockActive and unlinkSync above.
    try {
      const content = readFileSync(reclaimLockPath, 'utf8');
      const { pid } = parseLockContent(content);
      if (pid !== process.pid) {
        // Someone else owns the reclaim lock now — abandon without
        // unlinking their file (releaseReclaim would delete whatever is
        // currently at reclaimLockPath, which is theirs now).
        releaseReclaim = null;
        return null;
      }
    } catch {
      // Lock file disappeared — no longer safe to assume ownership.
      // Do not call releaseReclaim() here: we cannot confirm we own the
      // file at reclaimLockPath, so unlinking it could delete another
      // process's lock.
      releaseReclaim = null;
      return null;
    }
  }

  try {
    // Another process may have reclaimed and released already.
    const reacquired = tryAcquireLock();
    if (reacquired) {
      return reacquired;
    }

    // Re-check under reclaim lock before deleting.
    if (isResumeLockActive(iterationPath)) {
      return null;
    }

    // Safe to delete stale lock and claim it immediately.
    try {
      unlinkSync(lockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return null;
      }
    }

    return tryAcquireLock();
  } finally {
    releaseReclaim?.();
  }
}

/** Possible outcomes of a resume attempt. */
export type ResumeResult =
  | { status: 'ok'; resumedFromCheckpoint: boolean }
  | { status: 'not_resumable' }
  | { status: 'already_resuming' }
  | { status: 'failed'; error: string };

/**
 * Core resume logic extracted for reuse by both the `resume` command
 * and the automatic RetryScheduler.
 */
export interface ResumeOptions {
  /** Suppress informational console.log messages (e.g. in JSON mode). */
  quiet?: boolean;
  /** Keep the persisted auto-retry counter when the scheduler is resuming. */
  preserveAutoRetryCount?: boolean;
  /** Override the agent (e.g. "claude") and optionally model (e.g. "opus"). */
  agent?: string;
  agentModel?: string;
}

function checkpointHasRequiredExternalRepoState(
  iterationPath: string,
  taskWorktreePath: string,
  checkpoint: Record<string, unknown>
): boolean {
  const workspaceDescriptionPath = join(
    iterationPath,
    'workspace-description.json'
  );
  const legacyWorkspaceDescriptionPath = join(
    taskWorktreePath,
    '.rover-workspace.json'
  );

  const getRequiredProjectPaths = (): string[] => {
    if (existsSync(workspaceDescriptionPath)) {
      try {
        const raw = readFileSync(workspaceDescriptionPath, 'utf8');
        const parsed = JSON.parse(raw) as {
          projects?: Array<{ path?: unknown; repository?: unknown }>;
        };
        return (Array.isArray(parsed.projects) ? parsed.projects : []).flatMap(
          project =>
            typeof project?.path === 'string' &&
            typeof project?.repository === 'string'
              ? [project.path]
              : []
        );
      } catch {
        return [];
      }
    }

    if (existsSync(legacyWorkspaceDescriptionPath)) {
      try {
        const raw = readFileSync(legacyWorkspaceDescriptionPath, 'utf8');
        const parsed = JSON.parse(raw) as {
          projects?: Array<{ path?: unknown; repository?: unknown }>;
        };
        return (Array.isArray(parsed.projects) ? parsed.projects : []).flatMap(
          project =>
            typeof project?.path === 'string' &&
            typeof project?.repository === 'string'
              ? [project.path]
              : []
        );
      } catch {
        return [];
      }
    }

    return [];
  };

  try {
    const requiredProjectPaths = getRequiredProjectPaths();

    if (requiredProjectPaths.length === 0) {
      return true;
    }

    if (!Array.isArray(checkpoint.externalRepositories)) {
      return false;
    }

    const availablePaths = new Set(
      checkpoint.externalRepositories.flatMap(entry =>
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { path?: unknown }).path === 'string' &&
        typeof (entry as { head?: unknown }).head === 'string' &&
        typeof (entry as { trackedDiffHash?: unknown }).trackedDiffHash ===
          'string' &&
        typeof (entry as { untrackedHash?: unknown }).untrackedHash === 'string'
          ? [(entry as { path: string }).path]
          : []
      )
    );

    return requiredProjectPaths.every(path => availablePaths.has(path));
  } catch {
    return false;
  }
}

export async function resumeTask(
  project: ProjectManager,
  taskId: number,
  options: ResumeOptions = {}
): Promise<ResumeResult> {
  const log = options.quiet ? () => {} : console.log;

  const task = project.getTask(taskId);
  if (!task) {
    throw new TaskNotFoundError(taskId);
  }

  // Only PAUSED or FAILED tasks can be resumed
  if (!task.isPaused() && !task.isFailed()) {
    return { status: 'not_resumable' };
  }

  // Find checkpoint.json in the last iteration's output directory
  if (!task.iterations || task.iterations < 1) {
    log(
      colors.yellow(
        `  ⚠ Task ${taskId} has no iterations (iterations=${task.iterations}), cannot resume.`
      )
    );
    return { status: 'not_resumable' };
  }
  const iterationPath = join(task.iterationsPath(), task.iterations.toString());

  // Acquire file-based lock to prevent concurrent resume attempts
  // (e.g. manual `rover resume` racing with auto-retry from `rover list --watch`)
  mkdirSync(iterationPath, { recursive: true });
  const releaseLock = acquireResumeLock(iterationPath);
  if (!releaseLock) {
    log(
      colors.yellow(
        `  ⚠ Task ${taskId} is already being resumed by another process, skipping.`
      )
    );
    return { status: 'already_resuming' };
  }

  try {
    return await resumeTaskLocked(project, taskId, iterationPath, log, options);
  } finally {
    releaseLock();
  }
}

/**
 * Inner resume logic, called while holding the resume lock.
 */
async function resumeTaskLocked(
  project: ProjectManager,
  taskId: number,
  iterationPath: string,
  log: (...args: unknown[]) => void = console.log,
  options: ResumeOptions = {}
): Promise<ResumeResult> {
  // Re-read task from disk under lock — another process may have already
  // resumed the task between our initial check and lock acquisition.
  const task = project.getTask(taskId);
  if (!task || (!task.isPaused() && !task.isFailed())) {
    return { status: 'not_resumable' };
  }

  const statusBeforeResume = task.status;
  const errorBeforeResume = task.error;
  const statusJsonPath = join(iterationPath, 'status.json');
  const previousIterationStatus = existsSync(statusJsonPath)
    ? (() => {
        try {
          return IterationStatusManager.load(statusJsonPath);
        } catch {
          return null;
        }
      })()
    : null;
  const pauseProviderBeforeResume =
    statusBeforeResume === 'PAUSED'
      ? previousIterationStatus?.provider
      : undefined;

  const restoreResumableStatus = (fallbackError: string): void => {
    if (statusBeforeResume === 'FAILED') {
      task.markFailed(errorBeforeResume || fallbackError);
      return;
    }
    task.markPaused(errorBeforeResume || fallbackError);
  };

  // Atomically mark resume startup before spawning the container to prevent
  // races. This records a startup timestamp so orphan detection can recover a
  // crashed resume even if no replacement container ID was written yet.
  // NOTE: If the process crashes between this markResuming() and the
  // restoreResumableStatus() call in the error paths below, the task will be
  // be left in IN_PROGRESS without a confirmed replacement container. The
  // orphan detector (detectOrphanedTasks) uses the startup timestamp to
  // transition stale resumes back to FAILED so `rover resume` can recover it.
  task.markResuming(undefined, {
    resetAutoRetryCount: !options.preserveAutoRetryCount,
  });
  if (options.preserveAutoRetryCount) {
    task.setAutoRetryCount((task.autoRetryCount || 0) + 1);
  }

  const checkpointPath = join(iterationPath, 'checkpoint.json');
  // Validate checkpoint file is parseable JSON, not just present on disk.
  // A corrupted checkpoint should fall back to a full rerun from the existing
  // worktree rather than deleting task progress.
  let checkpointState: 'missing' | 'valid' | 'invalid' = 'missing';
  if (existsSync(checkpointPath)) {
    try {
      const raw = readFileSync(checkpointPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        Array.isArray(parsed.completedSteps) &&
        checkpointHasRequiredExternalRepoState(
          iterationPath,
          task.worktreePath,
          parsed as Record<string, unknown>
        )
      ) {
        checkpointState = 'valid';
        // Warn about step IDs in the checkpoint that may not exist in
        // the current workflow (e.g. workflow edited between pause and
        // resume). The agent will handle stale entries gracefully via
        // pruneStaleCheckpointEntries, but an early warning helps
        // users understand why some steps will be re-executed.
        const staleStepIds = parsed.completedSteps.filter(
          (s: unknown) =>
            s != null &&
            typeof s === 'object' &&
            typeof (s as { id?: unknown }).id === 'string' &&
            (s as { id: string }).id.length === 0
        );
        if (staleStepIds.length > 0) {
          log(
            colors.yellow(
              `  ⚠ Checkpoint contains ${staleStepIds.length} step(s) with empty IDs — they will be ignored on resume.`
            )
          );
        }
      } else {
        checkpointState = 'invalid';
        log(
          colors.yellow(
            `  ⚠ Checkpoint file for task ${taskId} has invalid or incomplete structure, ignoring it.`
          )
        );
      }
    } catch {
      checkpointState = 'invalid';
      log(
        colors.yellow(
          `  ⚠ Checkpoint file for task ${taskId} is corrupted, ignoring it.`
        )
      );
    }
  }

  // Ensure worktree exists and is valid
  let worktreePath = task.worktreePath;
  let branchName = task.branchName;

  if (!worktreePath) {
    worktreePath = project.getWorkspacePath(taskId);
  }
  if (!branchName) {
    branchName = generateBranchName(taskId);
  }

  const git = new Git({ cwd: project.path });
  const worktreeBaseRef = task.baseCommit || task.sourceBranch;

  const configureWorktree = (): void => {
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
  };

  const createWorktree = (): void => {
    if (!git.createWorktree(worktreePath, branchName, worktreeBaseRef)) {
      throw new Error('git worktree add failed');
    }
    configureWorktree();
  };

  const recreateWorktree = (): void => {
    if (existsSync(worktreePath)) {
      const removeResult = launchSync(
        'git',
        ['worktree', 'remove', worktreePath, '--force'],
        {
          cwd: project.path,
          reject: false,
        }
      );
      if (removeResult.exitCode !== 0 && existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
        launchSync('git', ['worktree', 'prune'], {
          cwd: project.path,
          reject: false,
        });
      }
    }

    const branchExists = launchSync(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
      {
        cwd: project.path,
        reject: false,
      }
    );
    if (branchExists.exitCode === 0) {
      const deleteBranchResult = launchSync(
        'git',
        ['branch', '-D', branchName],
        {
          cwd: project.path,
          reject: false,
        }
      );
      if (deleteBranchResult.exitCode !== 0) {
        const stderr = deleteBranchResult.stderr?.toString().trim();
        const stdout = deleteBranchResult.stdout?.toString().trim();
        throw new Error(
          stderr ||
            stdout ||
            `Failed to delete existing task branch ${branchName}`
        );
      }
    }

    createWorktree();
  };

  let worktreeCreated = false;
  if (checkpointState === 'missing') {
    try {
      recreateWorktree();
      worktreeCreated = true;
    } catch (error) {
      restoreResumableStatus('Resume failed: worktree could not be prepared');
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(
        colors.yellow(
          `  ⚠ Failed to recreate worktree for task ${taskId}: ${errorMsg}`
        )
      );
      return { status: 'failed', error: errorMsg };
    }
  } else if (!existsSync(worktreePath)) {
    const errorMsg =
      checkpointState === 'valid'
        ? 'Resume failed: task worktree is missing and cannot be recreated safely from a checkpoint'
        : 'Resume failed: task worktree is missing and checkpoint recovery cannot safely recreate it';
    const warningMsg =
      checkpointState === 'valid'
        ? `  ⚠ Task ${taskId} worktree is missing; refusing checkpoint resume from a recreated workspace.`
        : `  ⚠ Task ${taskId} worktree is missing and the checkpoint is unreadable; refusing to recreate the workspace automatically.`;
    restoreResumableStatus(errorMsg);
    log(colors.yellow(warningMsg));
    return { status: 'failed', error: errorMsg };
  } else {
    try {
      configureWorktree();
    } catch (error) {
      restoreResumableStatus(
        'Resume failed: worktree could not be refreshed from project config'
      );
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(
        colors.yellow(
          `  ⚠ Failed to refresh worktree for task ${taskId}: ${errorMsg}`
        )
      );
      return { status: 'failed', error: errorMsg };
    }
  }

  // Update task metadata when the worktree was freshly created or metadata
  // is missing (e.g. task predates worktree tracking, or metadata was lost)
  if (worktreeCreated || !task.worktreePath || !task.branchName) {
    try {
      task.setWorkspace(worktreePath, branchName);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(
        colors.yellow(
          `  ⚠ Failed to store workspace metadata for task ${taskId}: ${errorMsg}`
        )
      );
      restoreResumableStatus(
        'Resume failed: workspace metadata could not be stored'
      );
      return { status: 'failed', error: errorMsg };
    }
  }

  // Create initial iteration.json and reset status.json.
  // If either fails (e.g. disk full, permissions), restore the task to its
  // pre-resume status so it remains resumable rather than stuck IN_PROGRESS.
  let iterationStatus: IterationStatusManager;
  try {
    const iterationJsonPath = join(iterationPath, 'iteration.json');
    let needsCreation = !existsSync(iterationJsonPath);
    if (!needsCreation) {
      try {
        IterationManager.load(iterationPath);
      } catch {
        needsCreation = true;
      }
    }
    if (needsCreation) {
      IterationManager.createInitial(
        iterationPath,
        task.id,
        task.title,
        task.description
      );
    }

    // Reset the iteration status so stale paused/failed state is not
    // re-read before the resumed agent writes its first status update.
    iterationStatus = IterationStatusManager.createInitial(
      statusJsonPath,
      String(task.id),
      'Resuming workflow'
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(
      colors.yellow(
        `  ⚠ Failed to initialize iteration for task ${taskId}: ${errorMsg}`
      )
    );
    restoreResumableStatus('Resume failed: iteration initialization error');
    return { status: 'failed', error: errorMsg };
  }

  // Apply agent/model override if provided via options
  if (options.agent) {
    task.setAgent(options.agent, options.agentModel);
  }

  // Check if user provided a custom agent image via environment variable
  if (process.env.ROVER_AGENT_IMAGE) {
    task.setAgentImage(process.env.ROVER_AGENT_IMAGE);
  }

  // Remove stale .pause-requested file so the resumed agent doesn't
  // immediately re-pause from a previous pause request.
  const pauseRequestFile = join(iterationPath, '.pause-requested');
  if (existsSync(pauseRequestFile)) {
    try {
      unlinkSync(pauseRequestFile);
    } catch {
      // Non-fatal — the agent will still try to run
    }
  }

  // Start sandbox container for task execution
  try {
    const sandbox = await createSandbox(task, undefined, {
      projectPath: project.path,
      sandboxMetadata: task.sandboxMetadata,
      checkpointPath: checkpointState === 'valid' ? checkpointPath : undefined,
      resumeFromCheckpoint: checkpointState === 'valid',
      iterationLogsPath: project.getTaskIterationLogsPath(
        task.id,
        task.iterations
      ),
    });
    const containerId = await sandbox.createAndStart();
    const sandboxMetadata =
      typeof sandbox.getSandboxMetadata === 'function'
        ? sandbox.getSandboxMetadata()
        : process.env.DOCKER_HOST
          ? { dockerHost: process.env.DOCKER_HOST }
          : undefined;

    // Update task metadata with new container ID
    task.setContainerInfo(containerId, 'running', sandboxMetadata);
    // Task already marked IN_PROGRESS before container creation (under lock)

    return {
      status: 'ok',
      resumedFromCheckpoint: checkpointState === 'valid',
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(
      colors.yellow(`  ⚠ Sandbox start failed for task ${taskId}: ${errorMsg}`)
    );
    if (statusBeforeResume === 'FAILED') {
      iterationStatus.fail(
        'Resuming workflow',
        'Resume failed: container could not start'
      );
    } else {
      iterationStatus.pause(
        'Resuming workflow',
        'Resume failed: container could not start',
        pauseProviderBeforeResume
      );
    }
    restoreResumableStatus('Resume failed: container could not start');
    return { status: 'failed', error: errorMsg };
  }
}
