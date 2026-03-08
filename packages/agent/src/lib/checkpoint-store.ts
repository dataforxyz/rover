import colors from 'ansi-colors';
import {
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

export interface CheckpointCompletedStep {
  id: string;
  outputs: Record<string, string>;
}

export interface CheckpointLoopProgress {
  iteration: number;
  nextSubStepIndex: number;
  subStepOutputs: Record<string, Record<string, string>>;
  skippedSubSteps: string[];
}

export interface CheckpointExternalRepository {
  name: string;
  path: string;
  repository: string;
  head: string;
  trackedDiffHash: string;
  untrackedHash: string;
}

export interface CheckpointData {
  completedSteps: CheckpointCompletedStep[];
  loopProgress?: Record<string, CheckpointLoopProgress>;
  loopSignatures?: Record<string, string>;
  externalRepositories?: CheckpointExternalRepository[];
  failedStepId?: string;
  error?: string;
  isRetryable?: boolean;
  provider?: string;
}

function normalizeLoopProgress(
  value: unknown
): Record<string, CheckpointLoopProgress> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const normalized: Record<string, CheckpointLoopProgress> = {};

  for (const [loopId, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const iteration =
      typeof entry.iteration === 'number' &&
      Number.isInteger(entry.iteration) &&
      entry.iteration > 0
        ? entry.iteration
        : undefined;
    const nextSubStepIndex =
      typeof entry.nextSubStepIndex === 'number' &&
      Number.isInteger(entry.nextSubStepIndex) &&
      entry.nextSubStepIndex >= 0
        ? entry.nextSubStepIndex
        : undefined;

    if (iteration == null || nextSubStepIndex == null) {
      console.warn(
        `Warning: Skipping invalid loop progress for "${loopId}" (missing iteration or nextSubStepIndex)`
      );
      continue;
    }

    const rawSubStepOutputs = entry.subStepOutputs;
    const subStepOutputs: Record<string, Record<string, string>> = {};
    if (
      rawSubStepOutputs &&
      typeof rawSubStepOutputs === 'object' &&
      !Array.isArray(rawSubStepOutputs)
    ) {
      for (const [stepId, outputs] of Object.entries(rawSubStepOutputs)) {
        if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
          continue;
        }
        subStepOutputs[stepId] = Object.fromEntries(
          Object.entries(outputs).map(([key, outputValue]) => [
            key,
            String(outputValue),
          ])
        );
      }
    }

    const skippedSubSteps = Array.isArray(entry.skippedSubSteps)
      ? entry.skippedSubSteps.filter(
          (stepId: unknown): stepId is string => typeof stepId === 'string'
        )
      : [];

    normalized[loopId] = {
      iteration,
      nextSubStepIndex,
      subStepOutputs,
      skippedSubSteps,
    };
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function loadCheckpoint(path: string): CheckpointData | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.completedSteps)) return null;

    const completedSteps: CheckpointCompletedStep[] = data.completedSteps
      .filter(
        (step: unknown): step is { id: string; outputs?: unknown } =>
          step != null &&
          typeof step === 'object' &&
          typeof (step as any).id === 'string'
      )
      .map((step: { id: string; outputs?: Record<string, string> }) => ({
        id: step.id,
        outputs: Object.fromEntries(
          Object.entries(step.outputs ?? {}).map(([key, value]) => [
            key,
            String(value),
          ])
        ),
      }));

    const loopSignatures =
      data.loopSignatures &&
      typeof data.loopSignatures === 'object' &&
      !Array.isArray(data.loopSignatures)
        ? Object.fromEntries(
            Object.entries(data.loopSignatures)
              .filter(
                (entry): entry is [string, string] =>
                  typeof entry[0] === 'string' && typeof entry[1] === 'string'
              )
              .map(([loopId, signature]) => [loopId, signature])
          )
        : undefined;

    const externalRepositories = Array.isArray(data.externalRepositories)
      ? data.externalRepositories
          .filter(
            (
              entry: unknown
            ): entry is {
              name: string;
              path: string;
              repository: string;
              head: string;
              trackedDiffHash: string;
              untrackedHash: string;
            } =>
              entry != null &&
              typeof entry === 'object' &&
              typeof (entry as any).name === 'string' &&
              typeof (entry as any).path === 'string' &&
              typeof (entry as any).repository === 'string' &&
              typeof (entry as any).head === 'string' &&
              typeof (entry as any).trackedDiffHash === 'string' &&
              typeof (entry as any).untrackedHash === 'string'
          )
          .map(
            (entry: {
              name: string;
              path: string;
              repository: string;
              head: string;
              trackedDiffHash: string;
              untrackedHash: string;
            }) => ({
              name: entry.name,
              path: entry.path,
              repository: entry.repository,
              head: entry.head,
              trackedDiffHash: entry.trackedDiffHash,
              untrackedHash: entry.untrackedHash,
            })
          )
      : undefined;

    return {
      completedSteps,
      loopProgress: normalizeLoopProgress(data.loopProgress),
      loopSignatures:
        loopSignatures && Object.keys(loopSignatures).length > 0
          ? loopSignatures
          : undefined,
      externalRepositories:
        externalRepositories && externalRepositories.length > 0
          ? externalRepositories
          : undefined,
      failedStepId:
        typeof data.failedStepId === 'string' ? data.failedStepId : undefined,
      error: typeof data.error === 'string' ? data.error : undefined,
      isRetryable:
        typeof data.isRetryable === 'boolean' ? data.isRetryable : undefined,
      provider: typeof data.provider === 'string' ? data.provider : undefined,
    };
  } catch (err) {
    console.warn(
      colors.yellow(
        `Warning: Failed to load checkpoint: ${err instanceof Error ? err.message : String(err)}`
      )
    );
    return null;
  }
}

export function saveCheckpoint(
  outputDir: string | undefined,
  data: CheckpointData
): boolean {
  if (!outputDir) return false;
  const checkpointPath = join(outputDir, 'checkpoint.json');
  const tmpPath = checkpointPath + '.tmp';
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmpPath, checkpointPath);
    console.log(colors.gray(`  Checkpoint saved to ${checkpointPath}`));
    return true;
  } catch (err) {
    // Clean up stale .tmp file on failure
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup errors
    }
    console.warn(
      colors.yellow(
        `Warning: Failed to save checkpoint: ${err instanceof Error ? err.message : String(err)}`
      )
    );
    return false;
  }
}

export function clearCheckpointFile(outputDir: string | undefined): void {
  if (!outputDir) return;
  try {
    const checkpointPath = join(outputDir, 'checkpoint.json');
    rmSync(checkpointPath, { force: true });
  } catch (err) {
    console.warn(
      colors.yellow(
        `Warning: Failed to clear checkpoint: ${err instanceof Error ? err.message : String(err)}`
      )
    );
  }
}

export interface CheckpointStore {
  getData(): CheckpointData;
  getCompletedStep(stepId: string): CheckpointCompletedStep | undefined;
  getLoopProgress(loopId: string): CheckpointLoopProgress | undefined;
  getLoopSignature(loopId: string): string | undefined;
  /** Update loop progress in memory. Callers MUST call persist() afterwards
   *  to flush to disk — this method does not persist automatically. */
  setLoopProgress(loopId: string, progress: CheckpointLoopProgress): void;
  /** Record a loop signature in memory. Call persist() afterwards. */
  setLoopSignature(loopId: string, signature: string): void;
  /** Remove loop progress from memory. Call persist() afterwards. */
  clearLoopProgress(loopId: string): void;
  /** Replace the full completed steps list in memory. Call persist() afterwards. */
  setCompletedSteps(completedSteps: CheckpointCompletedStep[]): void;
  /** Replace external repository state in memory. Call persist() afterwards. */
  setExternalRepositories(
    repositories: CheckpointExternalRepository[] | undefined
  ): void;
  /** Upsert a single completed step into the internal list (in-memory only).
   *  Call persist() afterwards to flush to disk. */
  addCompletedStep(stepId: string, outputs: Record<string, string>): void;
  /** Flush the current in-memory state to disk. Call at well-defined
   *  boundaries (after step completion, on signal handler) rather than
   *  after every mutation to reduce I/O overhead. */
  persist(): boolean;
  saveFailureSnapshot(data: {
    completedSteps: CheckpointCompletedStep[];
    failedStepId: string;
    error?: string;
    isRetryable?: boolean;
    provider?: string;
  }): boolean;
}

export function createCheckpointStore(
  outputDir: string | undefined,
  initialData: CheckpointData | null = null
): CheckpointStore {
  // Shallow-copy the initial data; individual mutations (addCompletedStep,
  // setLoopProgress, etc.) already copy values on write, so a deep clone
  // at construction is unnecessary overhead.
  const data: CheckpointData = {
    completedSteps: initialData?.completedSteps
      ? [...initialData.completedSteps]
      : [],
    ...(initialData?.loopProgress
      ? {
          loopProgress: structuredClone(initialData.loopProgress),
        }
      : {}),
    ...(initialData?.loopSignatures
      ? {
          loopSignatures: { ...initialData.loopSignatures },
        }
      : {}),
    ...(initialData?.externalRepositories
      ? {
          externalRepositories: initialData.externalRepositories.map(entry => ({
            ...entry,
          })),
        }
      : {}),
    // Intentionally clear failure metadata from the previous run.
    // These fields are only meaningful for the run that wrote them;
    // a resumed run will set its own failure fields if it fails again.
    // Carrying them forward would cause intermediate persists (from
    // setCompletedSteps/setLoopProgress) to write stale failure data
    // to disk, which could be misleading if the process is killed.
    failedStepId: undefined,
    error: undefined,
    isRetryable: undefined,
    provider: undefined,
  };

  const persist = (): boolean => {
    return saveCheckpoint(outputDir, data);
  };

  return {
    getData: () => ({
      ...data,
      completedSteps: data.completedSteps.map(s => ({
        id: s.id,
        outputs: { ...s.outputs },
      })),
      ...(data.loopProgress
        ? { loopProgress: structuredClone(data.loopProgress) }
        : {}),
      ...(data.loopSignatures
        ? { loopSignatures: { ...data.loopSignatures } }
        : {}),
      ...(data.externalRepositories
        ? {
            externalRepositories: data.externalRepositories.map(entry => ({
              ...entry,
            })),
          }
        : {}),
    }),
    getCompletedStep(stepId: string) {
      const step = data.completedSteps.find(step => step.id === stepId);
      if (!step) return undefined;
      return { id: step.id, outputs: { ...step.outputs } };
    },
    getLoopProgress(loopId: string) {
      const progress = data.loopProgress?.[loopId];
      if (!progress) return undefined;
      return structuredClone(progress);
    },
    getLoopSignature(loopId: string) {
      return data.loopSignatures?.[loopId];
    },
    setLoopProgress(loopId: string, progress: CheckpointLoopProgress) {
      // Mirror load-time validation: reject clearly invalid values
      if (!Number.isInteger(progress.iteration) || progress.iteration <= 0) {
        console.warn(
          colors.yellow(
            `Warning: Ignoring invalid loop progress for "${loopId}": iteration=${progress.iteration}`
          )
        );
        return;
      }
      if (
        !Number.isInteger(progress.nextSubStepIndex) ||
        progress.nextSubStepIndex < 0
      ) {
        console.warn(
          colors.yellow(
            `Warning: Ignoring invalid loop progress for "${loopId}": nextSubStepIndex=${progress.nextSubStepIndex}`
          )
        );
        return;
      }

      if (!data.loopProgress) {
        data.loopProgress = {};
      }
      const deepCopiedOutputs: Record<string, Record<string, string>> = {};
      for (const [stepId, outputs] of Object.entries(progress.subStepOutputs)) {
        deepCopiedOutputs[stepId] = { ...outputs };
      }
      data.loopProgress[loopId] = {
        iteration: progress.iteration,
        nextSubStepIndex: progress.nextSubStepIndex,
        subStepOutputs: deepCopiedOutputs,
        skippedSubSteps: [...progress.skippedSubSteps],
      };
    },
    setLoopSignature(loopId: string, signature: string) {
      if (!data.loopSignatures) {
        data.loopSignatures = {};
      }
      data.loopSignatures[loopId] = signature;
    },
    clearLoopProgress(loopId: string) {
      if (!data.loopProgress?.[loopId]) return;
      delete data.loopProgress[loopId];
      if (Object.keys(data.loopProgress).length === 0) {
        delete data.loopProgress;
      }
    },
    setCompletedSteps(completedSteps: CheckpointCompletedStep[]) {
      data.completedSteps = completedSteps.map(step => ({
        id: step.id,
        outputs: { ...step.outputs },
      }));
    },
    setExternalRepositories(repositories) {
      data.externalRepositories = repositories?.map(entry => ({ ...entry }));
    },
    addCompletedStep(stepId: string, outputs: Record<string, string>) {
      const existing = data.completedSteps.findIndex(s => s.id === stepId);
      const entry = { id: stepId, outputs: { ...outputs } };
      if (existing >= 0) {
        data.completedSteps[existing] = entry;
      } else {
        data.completedSteps.push(entry);
      }
    },
    persist,
    saveFailureSnapshot({
      completedSteps,
      failedStepId,
      error,
      isRetryable,
      provider,
    }): boolean {
      // Batch both completedSteps and failure fields into a single persist() call
      data.completedSteps = completedSteps.map(step => ({
        id: step.id,
        outputs: { ...step.outputs },
      }));
      data.failedStepId = failedStepId;
      data.error = error;
      data.isRetryable = isRetryable;
      data.provider = provider;
      const saved = persist();
      if (!saved) {
        console.warn(
          colors.yellow(
            '⚠ WARNING: Checkpoint could not be saved before pause. Resume may replay completed steps.'
          )
        );
      }
      return saved;
    },
  };
}
