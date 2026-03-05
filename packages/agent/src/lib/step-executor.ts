/**
 * Unified step dispatcher for workflow execution.
 * Routes steps to the appropriate executor based on step type:
 *   - agent → Runner
 *   - command → CommandRunner
 *   - loop → iterative sub-step execution
 */

import colors from 'ansi-colors';
import {
  type WorkflowManager,
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
}

export type StepResult =
  | RunnerStepResult
  | CommandStepResult
  | ACPRunnerStepResult;

const DEFAULT_MAX_ITERATIONS = 3;

/**
 * Check whether a step should be skipped based on its `if` condition.
 */
export function shouldSkipStep(
  step: WorkflowStep,
  stepsOutput: Map<string, Map<string, string>>
): boolean {
  if (!step.if) return false;
  return !evaluateCondition(step.if, stepsOutput);
}

/**
 * Execute a single workflow step, dispatching by type.
 *
 * Callers are responsible for checking `shouldSkipStep()` before invoking
 * this function.  Top-level steps are checked in `run.ts`; loop sub-steps
 * are checked in `executeLoopStep()`.
 */
export async function executeStep(
  step: WorkflowStep,
  config: StepExecutorConfig
): Promise<StepResult> {
  if (isAgentStep(step)) {
    if (config.acpRunner) {
      const acpRunner = config.acpRunner;
      const managesSessionLifecycle = !config.reuseAcpSession;
      if (managesSessionLifecycle) {
        await acpRunner.createSession();
      }

      // Sync current stepsOutput into the acpRunner so prompt placeholders resolve
      for (const [stepId, outputs] of config.stepsOutput.entries()) {
        acpRunner.stepsOutput.set(stepId, outputs);
      }

      try {
        const result = await acpRunner.runStep(step.id);
        return result;
      } finally {
        if (managesSessionLifecycle) {
          acpRunner.closeSession();
        }
      }
    }

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
    return runner.run(config.output);
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

/**
 * Execute a loop step: iterate sub-steps until condition is met or max iterations reached.
 * The until condition is checked after each full iteration of sub-steps completes.
 */
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
  let hasLoopAcpSession = false;

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

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      lastIteration = iteration;
      console.log(
        colors.cyan(`\n  ↻ Loop iteration ${iteration}/${maxIterations}`)
      );

      for (const subStep of loopStep.steps) {
        // Check `if` condition on sub-steps (mirrors top-level skip in run.ts)
        if (shouldSkipStep(subStep, config.stepsOutput)) {
          console.log(
            colors.gray(
              `  ⏭ Skipping step "${subStep.name}" (condition not met)`
            )
          );
          config.stepsOutput.set(subStep.id, new Map());
          continue;
        }

        const subResult = await executeStep(subStep, {
          ...config,
          // Preserve parent context for progress reporting; sub-steps use the
          // loop's position within the overall workflow, not their own index.
          reuseAcpSession: config.reuseAcpSession || hasLoopAcpSession,
        });

        // Store sub-step outputs
        config.stepsOutput.set(subStep.id, subResult.outputs);

        // Log command step results so output (e.g. test results) is visible
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
          // NOTE: Loop sub-steps intentionally continue past failures.
          // The `until` condition (checked at the end of each iteration)
          // determines when the loop exits.  This differs from top-level
          // `continueOnError` handling because loops are designed for retry
          // patterns (e.g. TDD: tests fail → fix agent runs → tests re-run).
        }
      }

      // Check the `until` condition after all sub-steps in this iteration
      // have completed.  We intentionally do NOT check after each sub-step
      // because the condition may reference steps that haven't run yet in
      // the current iteration (e.g. `steps.checkpoint.outputs.exit_code != 0`
      // would be true for an undefined step, causing premature exit).
      // Individual sub-steps already have `if` guards to skip unnecessary work.
      if (evaluateCondition(loopStep.until, config.stepsOutput)) {
        conditionMet = true;
        console.log(colors.green(`  ✓ Loop condition met, exiting loop`));
      }

      if (conditionMet) break;
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

  if (!conditionMet) {
    console.log(
      colors.yellow(
        `  ⚠ Loop "${loopStep.name}" reached max iterations (${maxIterations}) without condition being met`
      )
    );
  }

  return {
    id: loopStep.id,
    success: conditionMet,
    error: conditionMet
      ? undefined
      : lastError || `Loop condition not met after ${maxIterations} iterations`,
    duration,
    outputs,
  };
}
