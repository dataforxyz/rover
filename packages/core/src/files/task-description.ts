/**
 * TaskDescriptionManager class - Centralized management of task metadata
 *
 * This class is path-agnostic: it receives the task's base path from the caller.
 * Path resolution is handled by ProjectManager, which knows about central and legacy locations.
 */
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  CURRENT_TASK_DESCRIPTION_SCHEMA_VERSION,
  TaskDescriptionSchema,
  TaskFileError,
  TaskNotFoundError,
  TaskSchemaError,
  TaskValidationError,
  type CreateTaskData,
  type IterationMetadata,
  type NetworkConfig,
  type StatusMetadata,
  type TaskDescription,
  type TaskStatus,
} from 'rover-schemas';
import { VERBOSE } from '../verbose.js';
import { IterationManager } from './iteration.js';

/**
 * TaskDescriptionManager class - Centralized management of task metadata
 */
export class TaskDescriptionManager {
  private data: TaskDescription;
  private taskId: number;
  private basePath: string;
  private filePath: string;

  constructor(data: TaskDescription, taskId: number, basePath: string) {
    this.data = data;
    this.taskId = taskId;
    this.basePath = basePath;
    this.filePath = join(basePath, 'description.json');
    this.validate();
  }

  // ============================================================
  // Static Factory Methods
  // ============================================================

  /**
   * Create a new task with initial metadata
   *
   * @param basePath - Base path for the task directory
   * @param taskData - Task creation data
   * @returns TaskDescriptionManager instance
   */
  static create(
    basePath: string,
    taskData: CreateTaskData
  ): TaskDescriptionManager {
    const now = new Date().toISOString();
    const uuid = taskData.uuid || randomUUID();

    const schema: TaskDescription = {
      id: taskData.id,
      uuid: uuid,
      title: taskData.title,
      description: taskData.description,
      inputs: Object.fromEntries(taskData.inputs),
      status: 'NEW',
      createdAt: now,
      startedAt: now,
      lastIterationAt: now,
      iterations: 1,
      worktreePath: '',
      workflowName: taskData.workflowName,
      branchName: '',
      agent: taskData.agent,
      agentModel: taskData.agentModel,
      sourceBranch: taskData.sourceBranch,
      rtkEnabled: taskData.rtkEnabled,
      networkConfig: taskData.networkConfig,
      source: taskData.source,
      version: CURRENT_TASK_DESCRIPTION_SCHEMA_VERSION,
    };

    // Ensure task directory exists
    mkdirSync(basePath, { recursive: true });

    const instance = new TaskDescriptionManager(schema, taskData.id, basePath);
    instance.save();
    instance.appendLifecycleEvent({
      timestamp: now,
      status: 'NEW',
      previousStatus: undefined,
      changeKind: 'created',
    });
    return instance;
  }

  /**
   * Load an existing task from disk
   *
   * @param basePath - Base path for the task directory
   * @param taskId - Task ID
   * @returns TaskDescriptionManager instance
   * @throws TaskNotFoundError if task doesn't exist
   */
  static load(basePath: string, taskId: number): TaskDescriptionManager {
    const filePath = join(basePath, 'description.json');

    if (!existsSync(filePath)) {
      throw new TaskNotFoundError(taskId);
    }

    try {
      const rawData = readFileSync(filePath, 'utf8');
      const parsedData = JSON.parse(rawData);

      // Migrate if necessary
      const migratedData = TaskDescriptionManager.migrate(parsedData, taskId);

      const instance = new TaskDescriptionManager(
        migratedData,
        taskId,
        basePath
      );

      // If migration occurred, save the updated data
      if (migratedData.version !== parsedData.version) {
        TaskDescriptionManager.createBackup(filePath);
        instance.save();
      }

      instance.reconcileLifecycleHistory();
      return instance;
    } catch (error) {
      if (error instanceof TaskNotFoundError) {
        throw error;
      }
      if (error instanceof SyntaxError) {
        throw new TaskSchemaError(
          `Invalid JSON in task ${taskId}: ${error.message}`
        );
      }
      throw new TaskFileError(`Failed to load task ${taskId}: ${error}`);
    }
  }

  /**
   * Check if a task exists at the given path
   *
   * @param basePath - Base path for the task directory
   * @returns true if task exists
   */
  static exists(basePath: string): boolean {
    const filePath = join(basePath, 'description.json');
    return existsSync(filePath);
  }

  // ============================================================
  // Private Static Helper Methods
  // ============================================================

  private static createBackup(filePath: string): void {
    const backupPath = `${filePath}.backup`;
    try {
      copyFileSync(filePath, backupPath);
    } catch (error) {
      console.warn(`Failed to create backup for ${filePath}:`, error);
    }
  }

  private static migrate(data: any, taskId: number): TaskDescription {
    // If already current version, return as-is
    if (data.version === CURRENT_TASK_DESCRIPTION_SCHEMA_VERSION) {
      return data as TaskDescription;
    }

    // Start with all existing data to preserve unknown fields
    const migrated: any = { ...data };

    // Apply required transformations and defaults
    migrated.id =
      typeof data.id === 'string' ? parseInt(data.id, 10) : data.id || taskId;
    migrated.uuid = data.uuid || randomUUID();
    migrated.title = data.title || 'Unknown Task';
    migrated.description = data.description || '';
    migrated.inputs = data.inputs || {};
    migrated.workflowName = data.workflowName || 'swe';
    migrated.status =
      TaskDescriptionManager.migrateStatus(data.status) || 'NEW';
    migrated.createdAt = data.createdAt || new Date().toISOString();
    migrated.iterations = data.iterations || 1;
    migrated.worktreePath = data.worktreePath || '';
    migrated.branchName = data.branchName || '';
    migrated.version = CURRENT_TASK_DESCRIPTION_SCHEMA_VERSION;

    // Preserve all execution-related fields
    migrated.containerId = data.containerId || '';
    // Migrate old dockerHost to sandboxMetadata
    if (data.dockerHost !== undefined) {
      migrated.sandboxMetadata = { dockerHost: data.dockerHost };
      // Remove the old dockerHost field after migration
      delete migrated.dockerHost;
    } else {
      migrated.sandboxMetadata = data.sandboxMetadata;
    }
    migrated.executionStatus = data.executionStatus || '';
    migrated.runningAt = data.runningAt || undefined;
    migrated.errorAt = data.errorAt || undefined;
    migrated.exitCode = data.exitCode ?? 0;

    // Preserve optional datetime fields
    migrated.startedAt = data.startedAt || undefined;
    migrated.completedAt = data.completedAt || undefined;
    migrated.failedAt = data.failedAt || undefined;
    migrated.pausedAt = data.pausedAt || undefined;
    migrated.lastIterationAt = data.lastIterationAt || undefined;
    migrated.lastStatusCheck = data.lastStatusCheck || undefined;

    // Preserve error information
    migrated.error = data.error;

    // Preserve restart tracking information
    migrated.restartCount = data.restartCount ?? 0;
    migrated.autoRetryCount = data.autoRetryCount ?? 0;
    migrated.lastRestartAt = data.lastRestartAt || undefined;
    migrated.lastResumedAt = data.lastResumedAt || undefined;

    // Preserve agent, agentModel, and sourceBranch fields
    migrated.agent = data.agent;
    migrated.agentModel = data.agentModel;
    migrated.sourceBranch = data.sourceBranch;

    // Preserve agentImage field
    migrated.agentImage = data.agentImage;

    // Preserve networkConfig field
    migrated.rtkEnabled = data.rtkEnabled;
    migrated.networkConfig = data.networkConfig;

    // Preserve baseCommit field
    migrated.baseCommit = data.baseCommit;

    // Preserve runSegments (operating time tracking)
    migrated.runSegments = data.runSegments;

    // Preserve task source (and migrate from old githubIssue if present)
    if (data.source) {
      migrated.source = data.source;
    } else if (data.githubIssue) {
      // Migrate old githubIssue format to new source format
      migrated.source = {
        type: 'github',
        id: String(data.githubIssue.number),
        url: `https://github.com/${data.githubIssue.repository}/issues/${data.githubIssue.number}`,
        ref: {
          owner: data.githubIssue.repository.split('/')[0],
          repo: data.githubIssue.repository.split('/')[1],
          number: data.githubIssue.number,
        },
      };
    }

    return migrated as TaskDescription;
  }

  private static migrateStatus(oldStatus: any): TaskStatus {
    if (typeof oldStatus !== 'string') return 'NEW';

    // Map old status values to new enum
    switch (oldStatus.toLowerCase()) {
      case 'new':
        return 'NEW';
      case 'in_progress':
      case 'running':
        return 'IN_PROGRESS';
      case 'iterating':
        return 'ITERATING';
      case 'completed':
        return 'COMPLETED';
      case 'failed':
        return 'FAILED';
      case 'merged':
        return 'MERGED';
      case 'pushed':
        return 'PUSHED';
      case 'paused':
        return 'PAUSED';
      default:
        return 'NEW';
    }
  }

  // ============================================================
  // CRUD Operations
  // ============================================================

  /**
   * Save current data to disk
   */
  save(): void {
    try {
      this.validate();
      const json = JSON.stringify(this.data, null, 2);
      writeFileSync(this.filePath, json, 'utf8');
    } catch (error) {
      throw new TaskFileError(`Failed to save task ${this.taskId}: ${error}`);
    }
  }

  /**
   * Reload data from disk
   */
  reload(): void {
    const reloaded = TaskDescriptionManager.load(this.basePath, this.taskId);
    this.data = reloaded.data;
  }

  /**
   * Delete the task file
   */
  delete(): void {
    try {
      this.appendLifecycleEvent({
        timestamp: new Date().toISOString(),
        status: this.data.status,
        previousStatus: this.data.status,
        reason: 'task deleted',
        changeKind: 'deleted',
      });
      if (existsSync(this.filePath)) {
        rmSync(this.filePath);
      }
    } catch (error) {
      throw new TaskFileError(`Failed to delete task ${this.taskId}: ${error}`);
    }
  }

  // ============================================================
  // Status Management
  // ============================================================

  /**
   * Set task status with optional metadata
   */
  setStatus(status: TaskStatus, metadata?: StatusMetadata): void {
    const previousStatus = this.data.status;
    const previousError = this.data.error;
    this.data.status = status;

    const timestamp = metadata?.timestamp || new Date().toISOString();

    // Track run segments for operating time
    this.updateRunSegments(previousStatus, status, timestamp);

    switch (status) {
      case 'NEW':
        // Clear stale metadata from a previous PAUSED, FAILED, or IN_PROGRESS state
        this.data.error = undefined;
        this.data.pausedAt = undefined;
        this.data.completedAt = undefined;
        this.data.failedAt = undefined;
        break;
      case 'IN_PROGRESS':
        if (!this.data.startedAt) {
          this.data.startedAt = timestamp;
        }
        // Clear stale error and pausedAt from a previous PAUSED or FAILED state on resume
        this.data.error = undefined;
        this.data.pausedAt = undefined;
        this.data.completedAt = undefined;
        this.data.failedAt = undefined;
        break;
      case 'ITERATING':
        this.data.lastIterationAt = timestamp;
        // Clear stale error and pausedAt from a previous PAUSED or FAILED state on resume
        this.data.error = undefined;
        this.data.pausedAt = undefined;
        this.data.completedAt = undefined;
        this.data.failedAt = undefined;
        break;
      case 'COMPLETED':
        this.data.completedAt = timestamp;
        this.data.error = undefined;
        this.data.pausedAt = undefined;
        break;
      case 'FAILED':
        this.data.failedAt = timestamp;
        this.data.pausedAt = undefined;
        // Intentionally clears error when metadata.error is undefined so that
        // stale errors from a previous status don't persist.
        this.data.error = metadata?.error;
        break;
      case 'PAUSED':
        this.data.pausedAt = timestamp;
        // Intentionally clears error when metadata.error is undefined so that
        // stale errors from a previous status don't persist.
        this.data.error = metadata?.error;
        this.data.completedAt = undefined;
        this.data.failedAt = undefined;
        break;
      case 'MERGED':
      case 'PUSHED':
        // Mark as completed when merged or pushed
        if (!this.data.completedAt) {
          this.data.completedAt = timestamp;
        }
        this.data.pausedAt = undefined;
        break;
    }

    this.data.lastStatusCheck = timestamp;
    this.save();
    this.appendLifecycleEvent({
      timestamp,
      status,
      previousStatus,
      reason: metadata?.error,
      previousReason: previousError,
    });
  }

  /**
   * Mark task as completed
   */
  markCompleted(completedAt?: string): void {
    this.setStatus('COMPLETED', { timestamp: completedAt });
  }

  /**
   * Mark task as failed with error message
   */
  markFailed(error: string, failedAt?: string): void {
    this.setStatus('FAILED', { timestamp: failedAt, error });
  }

  /**
   * Mark task as in progress
   */
  markInProgress(startedAt?: string): void {
    this.setStatus('IN_PROGRESS', { timestamp: startedAt });
  }

  /**
   * Mark a task as resuming so startup timeout recovery can detect crashes
   * before a replacement container ID has been recorded.
   */
  markResuming(
    startedAt?: string,
    options: { resetAutoRetryCount?: boolean } = {}
  ): void {
    const timestamp = startedAt || new Date().toISOString();
    this.data.restartCount = (this.data.restartCount || 0) + 1;
    if (options.resetAutoRetryCount ?? true) {
      this.data.autoRetryCount = 0;
    }
    this.data.lastResumedAt = timestamp;
    this.setStatus('IN_PROGRESS', { timestamp });
  }

  /**
   * Mark task as iterating
   */
  markIterating(timestamp?: string): void {
    this.setStatus('ITERATING', { timestamp });
  }

  /**
   * Mark task as merged
   */
  markMerged(timestamp?: string): void {
    this.setStatus('MERGED', { timestamp });
  }

  /**
   * Mark task as pushed
   */
  markPushed(timestamp?: string): void {
    this.setStatus('PUSHED', { timestamp });
  }

  /**
   * Mark task as paused (e.g., due to credit limit exhaustion)
   */
  markPaused(error?: string): void {
    this.setStatus('PAUSED', { error });
  }

  /**
   * Reset task back to NEW status (for container start failures or user reset)
   */
  resetToNew(timestamp?: string): void {
    this.setStatus('NEW', { timestamp });
  }

  /**
   * Restart a failed task by resetting to IN_PROGRESS  status and tracking restart attempt
   */
  restart(timestamp?: string): void {
    const restartTimestamp = timestamp || new Date().toISOString();

    // Increment restart count
    this.data.restartCount = (this.data.restartCount || 0) + 1;
    this.data.autoRetryCount = 0;
    this.data.lastRestartAt = restartTimestamp;

    // Reset to IN_PROGRESS status
    this.setStatus('IN_PROGRESS', { timestamp: restartTimestamp });
  }

  // ============================================================
  // Iteration Management
  // ============================================================

  /**
   * Increment iteration counter
   */
  incrementIteration(): void {
    this.data.iterations += 1;
    this.data.lastIterationAt = new Date().toISOString();
    this.save();
  }

  /**
   * Update iteration metadata
   */
  updateIteration(metadata: IterationMetadata): void {
    if (metadata.timestamp) {
      this.data.lastIterationAt = metadata.timestamp;
    }
    this.save();
  }

  /**
   * Load all iterations for this task
   * @returns Array of IterationManager instances, sorted by iteration number (descending)
   */
  getIterations(): IterationManager[] {
    const iterations: IterationManager[] = [];
    const iterationsPath = this.iterationsPath();

    if (existsSync(iterationsPath)) {
      try {
        const iterationsIds = readdirSync(iterationsPath, {
          withFileTypes: true,
        })
          .filter(dirent => dirent.isDirectory())
          .map(dirent => parseInt(dirent.name, 10))
          .filter(num => !Number.isNaN(num))
          .sort((a, b) => b - a); // Sort descending to get latest first

        iterationsIds.forEach(id => {
          try {
            iterations.push(
              IterationManager.load(join(iterationsPath, id.toString()))
            );
          } catch (err) {
            // For now, just logging
            if (VERBOSE) {
              console.error(
                `Error loading iteration ${id} for task ${this.taskId}: ${err}`
              );
            }
          }
        });
      } catch (err) {
        if (VERBOSE) {
          console.error(
            `Error retrieving iterations for task ${this.taskId}: ${err}`
          );
        }

        throw new Error(
          `Failed to retrieve iterations for task ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return iterations;
  }

  /**
   * Retrieve the latest iteration for this task
   * @returns The most recent IterationManager instance, or undefined if none exist
   */
  getLastIteration(): IterationManager | undefined {
    let taskIteration: IterationManager | undefined;
    const iterationsPath = this.iterationsPath();

    if (existsSync(iterationsPath)) {
      try {
        const iterationsIds = readdirSync(iterationsPath, {
          withFileTypes: true,
        })
          .filter(dirent => dirent.isDirectory())
          .map(dirent => parseInt(dirent.name, 10))
          .filter(num => !Number.isNaN(num))
          .sort((a, b) => b - a); // Sort descending to get latest first

        if (iterationsIds.length > 0) {
          taskIteration = IterationManager.load(
            join(iterationsPath, iterationsIds[0].toString())
          );
        } else {
          if (VERBOSE) {
            console.error(`Did not find any iteration for task ${this.taskId}`);
          }
        }
      } catch (err) {
        if (VERBOSE) {
          console.error(
            `Error retrieving iterations for task ${this.taskId}: ${err}`
          );
        }

        throw new Error(
          `Failed to retrieve iterations for task ${this.taskId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return taskIteration;
  }

  /**
   * Collect artifacts (summaries and plans) from all iterations before a given number.
   * Returns artifacts sorted by iteration number (ascending).
   */
  getPreviousIterationArtifacts(beforeIteration: number): {
    summaries: Array<{ iteration: number; content: string }>;
    plans: Array<{ iteration: number; content: string }>;
  } {
    const summaries: Array<{ iteration: number; content: string }> = [];
    const plans: Array<{ iteration: number; content: string }> = [];

    const allIterations = this.getIterations()
      .filter(iter => iter.iteration < beforeIteration)
      .sort((a, b) => a.iteration - b.iteration);

    for (const iter of allIterations) {
      const artifacts = iter.getArtifacts();
      if (artifacts.summary) {
        summaries.push({
          iteration: iter.iteration,
          content: artifacts.summary,
        });
      }
      if (artifacts.plan) {
        plans.push({ iteration: iter.iteration, content: artifacts.plan });
      }
    }

    return { summaries, plans };
  }

  /**
   * Update the task status based on the latest iteration
   */
  updateStatusFromIteration(): void {
    const iteration = this.getLastIteration();

    if (iteration != null) {
      const status = iteration.status();
      let statusName: TaskStatus;
      let timestamp;
      let error;

      switch (status.status) {
        case 'completed':
          statusName = 'COMPLETED';
          timestamp = status.completedAt;
          break;
        case 'failed':
          statusName = 'FAILED';
          timestamp = status.completedAt;
          error = status.error;
          break;
        case 'paused':
          statusName = 'PAUSED';
          timestamp = status.updatedAt;
          error = status.error;
          break;
        case 'running':
          statusName = 'ITERATING';
          timestamp = status.updatedAt;
          break;
        default:
          statusName = 'IN_PROGRESS';
          timestamp = status.updatedAt;
          break;
      }

      // The merged / pushed status is already a completed state
      if (
        statusName === 'COMPLETED' &&
        ['MERGED', 'PUSHED'].includes(this.data.status)
      ) {
        return;
      }

      const metadata = { timestamp, error };
      this.setStatus(statusName, metadata);
    }
  }

  // ============================================================
  // Workspace Management
  // ============================================================

  /**
   * Set workspace information
   */
  setWorkspace(worktreePath: string, branchName: string): void {
    this.data.worktreePath = worktreePath;
    this.data.branchName = branchName;
    this.save();
  }

  // ============================================================
  // Path Helpers
  // ============================================================

  /**
   * Get path to this task's iterations directory
   */
  iterationsPath(): string {
    return join(this.basePath, 'iterations');
  }

  /**
   * Get path to the current iteration directory
   */
  getIterationPath(): string {
    return join(this.iterationsPath(), this.data.iterations.toString());
  }

  /**
   * Get the base path for this task
   */
  getBasePath(): string {
    return this.basePath;
  }

  private readEntrypointAgent(iteration: number): string | undefined {
    const entrypointPath = join(
      this.iterationsPath(),
      iteration.toString(),
      'entrypoint.sh'
    );
    if (!existsSync(entrypointPath)) {
      return undefined;
    }

    try {
      const content = readFileSync(entrypointPath, 'utf8');
      const match = content.match(/^AGENT=([^\n\r]+)$/m);
      return match?.[1]?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private readLatestExecutionAgentInfo(
    iteration: number
  ): { agent?: string; model?: string } {
    const projectDataPath = dirname(dirname(this.basePath));
    const logPath = join(
      projectDataPath,
      'logs',
      'tasks',
      this.taskId.toString(),
      'iterations',
      iteration.toString(),
      'rover.jsonl'
    );
    if (!existsSync(logPath)) {
      return {};
    }

    try {
      const lines = readFileSync(logPath, 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

      let agent: string | undefined;
      let model: string | undefined;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as {
            agent?: unknown;
            model?: unknown;
          };
          if (typeof entry.agent === 'string' && entry.agent.trim()) {
            agent = entry.agent.trim();
          }
          if (typeof entry.model === 'string' && entry.model.trim()) {
            model = entry.model.trim();
          }
        } catch {
          continue;
        }
      }

      return { agent, model };
    } catch {
      return {};
    }
  }

  // ============================================================
  // Data Access (Getters)
  // ============================================================

  get id(): number {
    return this.data.id;
  }
  get uuid(): string {
    return this.data.uuid;
  }
  get title(): string {
    return this.data.title;
  }
  get description(): string {
    return this.data.description;
  }
  get status(): TaskStatus {
    return this.data.status;
  }
  get createdAt(): string {
    return this.data.createdAt;
  }
  get startedAt(): string | undefined {
    return this.data.startedAt;
  }
  get completedAt(): string | undefined {
    return this.data.completedAt;
  }
  get failedAt(): string | undefined {
    return this.data.failedAt;
  }
  get pausedAt(): string | undefined {
    return this.data.pausedAt;
  }
  get lastIterationAt(): string | undefined {
    return this.data.lastIterationAt;
  }
  get lastStatusCheck(): string | undefined {
    return this.data.lastStatusCheck;
  }
  get iterations(): number {
    return this.data.iterations;
  }
  get worktreePath(): string {
    return this.data.worktreePath;
  }
  get branchName(): string {
    return this.data.branchName;
  }
  get agent(): string | undefined {
    return this.data.agent;
  }
  get agentModel(): string | undefined {
    return this.data.agentModel;
  }
  get sourceBranch(): string | undefined {
    return this.data.sourceBranch;
  }
  get containerId(): string | undefined {
    return this.data.containerId;
  }
  get sandboxMetadata(): Record<string, unknown> | undefined {
    return this.data.sandboxMetadata;
  }
  get executionStatus(): string | undefined {
    return this.data.executionStatus;
  }
  get runningAt(): string | undefined {
    return this.data.runningAt;
  }
  get errorAt(): string | undefined {
    return this.data.errorAt;
  }
  get exitCode(): number | undefined {
    return this.data.exitCode;
  }
  get error(): string | undefined {
    return this.data.error;
  }
  get restartCount(): number | undefined {
    return this.data.restartCount;
  }
  get autoRetryCount(): number | undefined {
    return this.data.autoRetryCount;
  }
  get lastRestartAt(): string | undefined {
    return this.data.lastRestartAt;
  }
  get lastResumedAt(): string | undefined {
    return this.data.lastResumedAt;
  }
  get version(): string {
    return this.data.version;
  }
  get workflowName(): string {
    return this.data.workflowName;
  }
  get rawData(): TaskDescription {
    return { ...this.data };
  }
  get inputs(): Record<string, string> {
    return this.data.inputs;
  }
  get agentImage(): string | undefined {
    return this.data.agentImage;
  }
  get rtkEnabled(): boolean | undefined {
    return this.data.rtkEnabled;
  }
  get networkConfig(): NetworkConfig | undefined {
    return this.data.networkConfig;
  }
  get baseCommit(): string | undefined {
    return this.data.baseCommit;
  }
  get source(): TaskDescription['source'] {
    return this.data.source;
  }

  private getLatestIterationNumber(): number | undefined {
    const iteration = this.data.iterations;
    if (!Number.isInteger(iteration) || iteration < 1) {
      return undefined;
    }
    return iteration;
  }

  getEffectiveAgentInfo(): { agent?: string; model?: string } {
    const iterationNumber = this.getLatestIterationNumber();
    const logInfo = iterationNumber
      ? this.readLatestExecutionAgentInfo(iterationNumber)
      : {};
    const entrypointAgent = iterationNumber
      ? this.readEntrypointAgent(iterationNumber)
      : undefined;
    const agent = logInfo.agent || entrypointAgent || this.data.agent;
    const model =
      logInfo.model ||
      (agent && agent === this.data.agent ? this.data.agentModel : undefined);

    return { agent, model };
  }
  get runSegments(): TaskDescription['runSegments'] {
    return this.data.runSegments;
  }
  get onCompleteHookFiredAt(): TaskDescription['onCompleteHookFiredAt'] {
    return this.data.onCompleteHookFiredAt;
  }

  // ============================================================
  // Data Modification (Setters)
  // ============================================================

  /**
   * Set task source
   */
  setSource(source: TaskDescription['source']): void {
    this.data.source = source;
    this.save();
  }

  /**
   * Update task title
   */
  updateTitle(title: string): void {
    this.data.title = title;
    this.save();
  }

  /**
   * Update task description
   */
  updateDescription(description: string): void {
    this.data.description = description;
    this.save();
  }

  /**
   * Set agent image
   */
  setAgent(agent: string, model?: string): void {
    this.data.agent = agent;
    this.data.agentModel = model;
    this.save();
  }

  setAgentImage(agentImage: string): void {
    this.data.agentImage = agentImage;
    this.save();
  }

  setAutoRetryCount(count: number): void {
    this.data.autoRetryCount = count;
    this.save();
  }

  /**
   * Set the base commit hash (the commit when the worktree was created)
   */
  setBaseCommit(commit: string): void {
    this.data.baseCommit = commit;
    this.save();
  }

  /**
   * Record that the onComplete hook was fired at a specific lastStatusCheck timestamp.
   * Used to prevent duplicate hook executions while allowing re-fires after iterate/restart.
   */
  setOnCompleteHookFiredAt(timestamp: string): void {
    this.data.onCompleteHookFiredAt = timestamp;
    this.save();
  }

  // ============================================================
  // Docker Execution Management
  // ============================================================

  /**
   * Set container execution information
   */
  setContainerInfo(
    containerId: string,
    executionStatus: string,
    sandboxMetadata?: Record<string, unknown>
  ): void {
    this.data.containerId = containerId;
    this.data.executionStatus = executionStatus;
    this.data.sandboxMetadata = sandboxMetadata;
    if (executionStatus === 'running') {
      this.data.runningAt = new Date().toISOString();
    }
    this.save();
  }

  /**
   * Update execution status
   */
  updateExecutionStatus(
    status: string,
    metadata?: { exitCode?: number; error?: string }
  ): void {
    const timestamp = new Date().toISOString();
    this.data.executionStatus = status;

    if (metadata?.exitCode !== undefined) {
      this.data.exitCode = metadata.exitCode;
    }

    if (metadata?.error) {
      this.data.errorAt = timestamp;
    }

    if (status === 'completed') {
      this.setStatus('COMPLETED', { timestamp });
      return;
    } else if (status === 'failed') {
      this.setStatus('FAILED', { timestamp, error: metadata?.error });
      return;
    } else if (status === 'paused') {
      this.setStatus('PAUSED', { timestamp, error: metadata?.error });
      return;
    } else if (metadata?.error) {
      this.data.error = metadata.error;
    }

    this.save();
  }

  // ============================================================
  // Utility Methods
  // ============================================================

  /**
   * Get raw JSON data
   */
  toJSON(): TaskDescription {
    return { ...this.data };
  }

  /**
   * Check if task is completed
   */
  isCompleted(): boolean {
    return this.data.status === 'COMPLETED';
  }

  private roverDir(): string {
    const tasksDir = dirname(this.basePath);
    const maybeRoverDir = dirname(tasksDir);
    if (
      basename(tasksDir) === 'tasks' &&
      basename(maybeRoverDir) === '.rover'
    ) {
      return maybeRoverDir;
    }
    return join(dirname(dirname(this.basePath)), '.rover');
  }

  private lifecycleLogPath(): string {
    return join(this.roverDir(), 'logs', 'task-status-history.jsonl');
  }

  private deriveLifecycleReasonCode(
    reason?: string,
    changeKind?: string
  ): string {
    const text = String(reason || '').toLowerCase();
    if (changeKind === 'deleted') return 'task_deleted';
    if (!text) return '';
    if (text.includes('at capacity') || text.includes('waiting for slot')) {
      return 'capacity_wait';
    }
    if (text.includes('blocked (resets in') || text.includes(' blocked')) {
      return 'provider_blocked';
    }
    if (
      text.includes('five_hour') ||
      text.includes('seven_day') ||
      text.includes('threshold=') ||
      text.includes('save=')
    ) {
      return 'quota_guard';
    }
    if (text.includes('credit limit') || text.includes('usage limit')) {
      return 'credit_limit';
    }
    if (text.includes('rate limit') || text.includes('too many requests')) {
      return 'rate_limit';
    }
    if (
      text.includes('auth') ||
      text.includes('login') ||
      text.includes('sign in')
    ) {
      return 'auth_required';
    }
    if (
      text.includes('network') ||
      text.includes('timeout') ||
      text.includes('timed out')
    ) {
      return 'network_timeout';
    }
    if (text.includes('step failure') || text.includes('step failed')) {
      return 'workflow_step_failed';
    }
    if (
      text.includes('container') &&
      (text.includes('exit') || text.includes('crash'))
    ) {
      return 'container_crashed';
    }
    if (text.includes('signal')) {
      return 'signal_interrupt';
    }
    if (text.includes('task deleted')) {
      return 'task_deleted';
    }
    return 'unknown_reason';
  }

  private appendLifecycleEvent(params: {
    timestamp: string;
    status: string;
    previousStatus?: string;
    reason?: string;
    previousReason?: string;
    changeKind?: 'created' | 'transition' | 'reason_update' | 'deleted';
  }): void {
    const {
      timestamp,
      status,
      previousStatus,
      reason,
      previousReason,
      changeKind,
    } = params;

    const kind =
      changeKind ??
      (previousStatus === status ? 'reason_update' : 'transition');

    if (kind === 'transition' && previousStatus === status) {
      return;
    }

    if (kind === 'reason_update' && (!reason || reason === previousReason)) {
      return;
    }

    const payload = {
      ts: timestamp,
      event: 'task_status',
      changeKind: kind,
      source: 'host',
      actor: 'system',
      taskId: this.data.id,
      taskUuid: this.data.uuid,
      title: this.data.title,
      branchName: this.data.branchName,
      workflowName: this.data.workflowName,
      status,
      previousStatus: previousStatus ?? null,
      reason: reason || '',
      reasonCode: this.deriveLifecycleReasonCode(reason, kind),
      iteration: this.data.iterations,
      agent: this.data.agent || '',
      agentModel: this.data.agentModel || '',
    };

    try {
      const path = this.lifecycleLogPath();
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(payload)}\n`, 'utf8');
    } catch (error) {
      if (VERBOSE) {
        console.error(
          `Failed to append lifecycle event for task ${this.taskId}: ${error}`
        );
      }
    }
  }

  private latestLifecycleEventForTask():
    | {
        status?: string;
        reason?: string;
      }
    | undefined {
    const path = this.lifecycleLogPath();
    if (!existsSync(path)) {
      return undefined;
    }

    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line) continue;
        const parsed = JSON.parse(line) as {
          taskId?: number;
          taskUuid?: string;
          status?: string;
          reason?: string;
        };
        if (
          parsed.taskId === this.data.id &&
          parsed.taskUuid === this.data.uuid
        ) {
          return parsed;
        }
      }
    } catch (error) {
      if (VERBOSE) {
        console.error(
          `Failed to read lifecycle events for task ${this.taskId}: ${error}`
        );
      }
    }

    return undefined;
  }

  private currentLifecycleTimestamp(): string {
    return (
      this.data.lastStatusCheck ||
      this.data.failedAt ||
      this.data.pausedAt ||
      this.data.completedAt ||
      this.data.lastIterationAt ||
      this.data.startedAt ||
      this.data.createdAt ||
      new Date().toISOString()
    );
  }

  private reconcileLifecycleHistory(): void {
    const latestEvent = this.latestLifecycleEventForTask();
    const currentStatus = this.data.status;
    const currentReason = this.data.error || '';
    const timestamp = this.currentLifecycleTimestamp();

    if (!latestEvent) {
      this.appendLifecycleEvent({
        timestamp,
        status: currentStatus,
        previousStatus: undefined,
        reason: currentReason,
        changeKind: currentStatus === 'NEW' ? 'created' : 'transition',
      });
      return;
    }

    if (latestEvent.status !== currentStatus) {
      this.appendLifecycleEvent({
        timestamp,
        status: currentStatus,
        previousStatus: latestEvent.status,
        reason: currentReason,
        previousReason: latestEvent.reason,
      });
      return;
    }

    if (currentReason && currentReason !== (latestEvent.reason || '')) {
      this.appendLifecycleEvent({
        timestamp,
        status: currentStatus,
        previousStatus: latestEvent.status,
        reason: currentReason,
        previousReason: latestEvent.reason,
        changeKind: 'reason_update',
      });
    }
  }

  /**
   * Check if task failed
   */
  isFailed(): boolean {
    return this.data.status === 'FAILED';
  }

  /**
   * Check if task is in progress
   */
  isInProgress(): boolean {
    return this.data.status === 'IN_PROGRESS';
  }

  /**
   * Check if task is iterating
   */
  isIterating(): boolean {
    return this.data.status === 'ITERATING';
  }

  /**
   * Check if task is new
   */
  isNew(): boolean {
    return this.data.status === 'NEW';
  }

  /**
   * Check if task is merged
   */
  isMerged(): boolean {
    return this.data.status === 'MERGED';
  }

  /**
   * Check if task is pushed
   */
  isPushed(): boolean {
    return this.data.status === 'PUSHED';
  }

  /**
   * Check if task is paused
   */
  isPaused(): boolean {
    return this.data.status === 'PAUSED';
  }

  /**
   * Check if task is in an active state (NEW, IN_PROGRESS, or ITERATING)
   * PAUSED is NOT active - it's idle, waiting for external resume.
   */
  isActive(): boolean {
    return this.isNew() || this.isInProgress() || this.isIterating();
  }

  /**
   * Get task duration in milliseconds (wall-clock time from start to end)
   */
  getDuration(): number | null {
    if (!this.data.startedAt) return null;

    const endTime = this.data.completedAt || this.data.failedAt;
    if (!endTime) return null;

    const start = new Date(this.data.startedAt);
    const end = new Date(endTime);

    return end.getTime() - start.getTime();
  }

  /**
   * Get actual operating time in milliseconds.
   * Sums completed run segments and adds elapsed time for any open segment.
   * Returns null if no segments have been recorded.
   */
  getOperatingTime(): number | null {
    const segments = this.data.runSegments;
    if (!segments || segments.length === 0) return null;

    let totalMs = 0;
    for (const seg of segments) {
      const start = new Date(seg.start).getTime();
      const end = seg.end ? new Date(seg.end).getTime() : Date.now();
      totalMs += end - start;
    }
    return totalMs;
  }

  // ============================================================
  // Run Segment Tracking (Private)
  // ============================================================

  private static isActiveStatus(status: TaskStatus): boolean {
    return status === 'IN_PROGRESS' || status === 'ITERATING';
  }

  /**
   * Open or close a run segment when the task transitions between active and
   * inactive states. Called from setStatus() before the status-specific logic.
   */
  private updateRunSegments(
    previousStatus: TaskStatus,
    newStatus: TaskStatus,
    timestamp: string
  ): void {
    const wasActive = TaskDescriptionManager.isActiveStatus(previousStatus);
    const isActive = TaskDescriptionManager.isActiveStatus(newStatus);

    if (!wasActive && isActive) {
      // Entering an active state — open a new segment
      if (!this.data.runSegments) {
        this.data.runSegments = [];
      }
      this.data.runSegments.push({ start: timestamp });
    } else if (wasActive && !isActive) {
      // Leaving an active state — close the open segment
      if (this.data.runSegments && this.data.runSegments.length > 0) {
        const last = this.data.runSegments[this.data.runSegments.length - 1];
        if (!last.end) {
          last.end = timestamp;
        }
      }
    }
    // active → active or inactive → inactive: no segment change needed
  }

  // ============================================================
  // Validation
  // ============================================================

  /**
   * Validate the task data using Zod schema
   */
  private validate(): void {
    const result = TaskDescriptionSchema.safeParse(this.data);

    if (!result.success) {
      throw new TaskValidationError(
        `Task validation failed: ${result.error.message}`
      );
    }
  }
}
