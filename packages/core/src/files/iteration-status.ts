/**
 * Iteration status manager for tracking workflow execution progress.
 * Handles loading, validating, and managing iteration status with file persistence.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  IterationStatusSchema,
  IterationStatusLoadError,
  IterationStatusValidationError,
  type IterationStatus,
  type IterationStatusName,
  ZodError,
} from 'rover-schemas';

/**
 * IterationStatusManager class - Manages iteration status tracking and persistence.
 * Provides methods to create, load, update, and save status information with Zod validation.
 */
export class IterationStatusManager {
  private data: IterationStatus;
  private filePath: string;

  private constructor(data: unknown, filePath: string) {
    try {
      // Validate data with Zod schema
      this.data = IterationStatusSchema.parse(data);
      this.filePath = filePath;
    } catch (error) {
      if (error instanceof ZodError) {
        const errorMessages = error.issues
          .map(err => `  - ${err.path.join('.')}: ${err.message}`)
          .join('\n');
        throw new IterationStatusValidationError(
          `Iteration status validation failed:\n${errorMessages}`,
          error
        );
      }
      throw error;
    }
  }

  /**
   * Create a new initial iteration status
   */
  static createInitial(
    filePath: string,
    taskId: string,
    currentStep: string
  ): IterationStatusManager {
    const now = new Date().toISOString();

    const statusData = {
      taskId,
      status: 'initializing',
      currentStep,
      progress: 0,
      startedAt: now,
      updatedAt: now,
    };

    const instance = new IterationStatusManager(statusData, filePath);
    instance.save();
    return instance;
  }

  /**
   * Load an existing iteration status from disk
   */
  static load(filePath: string): IterationStatusManager {
    if (!existsSync(filePath)) {
      throw new IterationStatusLoadError(
        `Status file not found at ${filePath}`
      );
    }

    try {
      const rawData = readFileSync(filePath, 'utf8');
      const parsedData = JSON.parse(rawData);
      return new IterationStatusManager(parsedData, filePath);
    } catch (error) {
      // Re-throw validation errors as-is
      if (error instanceof IterationStatusValidationError) {
        throw error;
      }
      if (error instanceof SyntaxError) {
        throw new IterationStatusLoadError(
          `Invalid JSON in status file: ${error.message}`,
          error
        );
      }
      if (error instanceof Error) {
        throw new IterationStatusLoadError(
          `Failed to load status file: ${error.message}`,
          error
        );
      }
      throw new IterationStatusLoadError(
        `Failed to load status file: ${String(error)}`
      );
    }
  }

  /**
   * Update status with new information
   */
  update(
    status: IterationStatusName,
    currentStep: string,
    progress: number,
    error?: string
  ): void {
    this.data.status = status;
    this.data.currentStep = currentStep;
    this.data.progress = progress;
    this.data.updatedAt = new Date().toISOString();
    // Clear stale provider from a previous pause
    this.data.provider = undefined;

    // Clear or update error — ensures stale errors from a previous pause
    // don't persist after a successful resume.  Treat empty string as "no error".
    this.data.error = error || undefined;

    this.save();
  }

  /**
   * Mark status as completed
   */
  complete(currentStep: string): void {
    const now = new Date().toISOString();
    this.data.status = 'completed';
    this.data.currentStep = currentStep;
    this.data.progress = 100;
    this.data.updatedAt = now;
    this.data.completedAt = now;
    // Clear stale error and provider from a previous pause
    this.data.error = undefined;
    this.data.provider = undefined;
    this.save();
  }

  /**
   * Mark status as failed with error message
   */
  fail(currentStep: string, error: string): void {
    const now = new Date().toISOString();
    this.data.status = 'failed';
    this.data.currentStep = currentStep;
    this.data.progress = 100;
    this.data.error = error;
    this.data.updatedAt = now;
    this.data.completedAt = now;
    // Clear stale provider from a previous pause
    this.data.provider = undefined;
    this.save();
  }

  /**
   * Mark status as paused (e.g., due to credit limit exhaustion)
   * Unlike fail(), this does NOT set completedAt since the workflow is not terminal.
   */
  pause(currentStep: string, error: string, provider?: string): void {
    // Guard against pausing a terminal iteration — completed/failed
    // iterations should not be overwritten back to paused.
    if (this.data.status === 'completed' || this.data.status === 'failed') {
      console.warn(
        `Warning: Ignoring pause() on iteration already in terminal status "${this.data.status}" (task ${this.data.taskId})`
      );
      return;
    }
    this.data.status = 'paused';
    this.data.currentStep = currentStep;
    this.data.error = error || undefined;
    // Explicitly set provider — clears stale value from a previous pause
    // when no provider is given for this pause.
    this.data.provider = provider || undefined;
    this.data.updatedAt = new Date().toISOString();
    this.save();
  }

  /** Whether the last save() call failed, meaning in-memory state may differ from disk. */
  private _lastSaveFailed = false;

  /** Returns true if the last save() call failed and disk state may be stale. */
  get lastSaveFailed(): boolean {
    return this._lastSaveFailed;
  }

  /**
   * Save current status to disk.
   * Logs a warning on write failure rather than throwing, because callers
   * (including signal handlers) may not have error handling in place and a
   * thrown exception could prevent checkpoint saves or exit-code logic.
   */
  private save(): void {
    try {
      const json = JSON.stringify(this.data, null, 2);
      writeFileSync(this.filePath, json, 'utf8');
      this._lastSaveFailed = false;
    } catch (err) {
      this._lastSaveFailed = true;
      console.warn(
        `Warning: Failed to save iteration status to ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Getters for accessing status data
  get taskId(): string {
    return this.data.taskId;
  }

  get status(): IterationStatusName {
    return this.data.status;
  }

  get currentStep(): string {
    return this.data.currentStep;
  }

  get progress(): number {
    return this.data.progress;
  }

  get startedAt(): string {
    return this.data.startedAt;
  }

  get updatedAt(): string {
    return this.data.updatedAt;
  }

  get completedAt(): string | undefined {
    return this.data.completedAt;
  }

  get error(): string | undefined {
    return this.data.error;
  }

  get provider(): string | undefined {
    return this.data.provider;
  }

  /**
   * Get raw JSON data
   */
  toJSON(): IterationStatus {
    return { ...this.data };
  }
}
