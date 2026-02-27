import colors from 'ansi-colors';
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
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

export interface CheckpointData {
  completedSteps: CheckpointCompletedStep[];
  loopProgress?: Record<string, CheckpointLoopProgress>;
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

    if (iteration == null || nextSubStepIndex == null) continue;

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

    const completedSteps: CheckpointCompletedStep[] = data.completedSteps.map(
      (step: { id: string; outputs: Record<string, string> }) => ({
        id: step.id,
        outputs: Object.fromEntries(
          Object.entries(step.outputs ?? {}).map(([key, value]) => [
            key,
            String(value),
          ])
        ),
      })
    );

    return {
      completedSteps,
      loopProgress: normalizeLoopProgress(data.loopProgress),
      failedStepId:
        typeof data.failedStepId === 'string' ? data.failedStepId : undefined,
      error: typeof data.error === 'string' ? data.error : undefined,
      isRetryable:
        typeof data.isRetryable === 'boolean' ? data.isRetryable : undefined,
      provider: typeof data.provider === 'string' ? data.provider : undefined,
    };
  } catch {
    return null;
  }
}

export function saveCheckpoint(
  outputDir: string | undefined,
  data: CheckpointData
): void {
  if (!outputDir) return;
  try {
    const checkpointPath = join(outputDir, 'checkpoint.json');
    writeFileSync(checkpointPath, JSON.stringify(data, null, 2), 'utf8');
    console.log(colors.gray(`  Checkpoint saved to ${checkpointPath}`));
  } catch (err) {
    console.error(
      colors.yellow(
        `Warning: Failed to save checkpoint: ${err instanceof Error ? err.message : String(err)}`
      )
    );
  }
}

export function clearCheckpointFile(outputDir: string | undefined): void {
  if (!outputDir) return;
  try {
    const checkpointPath = join(outputDir, 'checkpoint.json');
    if (!existsSync(checkpointPath)) return;
    rmSync(checkpointPath, { force: true });
  } catch (err) {
    console.error(
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
  setLoopProgress(loopId: string, progress: CheckpointLoopProgress): void;
  clearLoopProgress(loopId: string): void;
  setCompletedSteps(completedSteps: CheckpointCompletedStep[]): void;
  setFailure(data: {
    failedStepId: string;
    error?: string;
    isRetryable?: boolean;
    provider?: string;
  }): void;
  saveFailureSnapshot(data: {
    completedSteps: CheckpointCompletedStep[];
    failedStepId: string;
    error?: string;
    isRetryable?: boolean;
    provider?: string;
  }): void;
}

export function createCheckpointStore(
  outputDir: string | undefined,
  initialData: CheckpointData | null = null
): CheckpointStore {
  const data: CheckpointData = {
    completedSteps: initialData?.completedSteps ?? [],
    ...(initialData?.loopProgress
      ? { loopProgress: { ...initialData.loopProgress } }
      : {}),
    failedStepId: initialData?.failedStepId,
    error: initialData?.error,
    isRetryable: initialData?.isRetryable,
    provider: initialData?.provider,
  };

  const persist = () => {
    saveCheckpoint(outputDir, data);
  };

  return {
    getData: () => data,
    getCompletedStep(stepId: string) {
      return data.completedSteps.find(step => step.id === stepId);
    },
    getLoopProgress(loopId: string) {
      return data.loopProgress?.[loopId];
    },
    setLoopProgress(loopId: string, progress: CheckpointLoopProgress) {
      if (!data.loopProgress) {
        data.loopProgress = {};
      }
      data.loopProgress[loopId] = {
        iteration: progress.iteration,
        nextSubStepIndex: progress.nextSubStepIndex,
        subStepOutputs: { ...progress.subStepOutputs },
        skippedSubSteps: [...progress.skippedSubSteps],
      };
      persist();
    },
    clearLoopProgress(loopId: string) {
      if (!data.loopProgress?.[loopId]) return;
      delete data.loopProgress[loopId];
      if (Object.keys(data.loopProgress).length === 0) {
        delete data.loopProgress;
      }
      persist();
    },
    setCompletedSteps(completedSteps: CheckpointCompletedStep[]) {
      data.completedSteps = completedSteps.map(step => ({
        id: step.id,
        outputs: { ...step.outputs },
      }));
      persist();
    },
    setFailure({ failedStepId, error, isRetryable, provider }) {
      data.failedStepId = failedStepId;
      data.error = error;
      data.isRetryable = isRetryable;
      data.provider = provider;
      persist();
    },
    saveFailureSnapshot({
      completedSteps,
      failedStepId,
      error,
      isRetryable,
      provider,
    }) {
      data.completedSteps = completedSteps.map(step => ({
        id: step.id,
        outputs: { ...step.outputs },
      }));
      data.failedStepId = failedStepId;
      data.error = error;
      data.isRetryable = isRetryable;
      data.provider = provider;
      persist();
    },
  };
}
