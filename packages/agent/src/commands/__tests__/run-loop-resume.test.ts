import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StepResult } from 'rover-core';

vi.mock('rover-core', async () => {
  const actual =
    await vi.importActual<typeof import('rover-core')>('rover-core');
  return {
    ...actual,
    launch: vi.fn(),
    launchSync: vi.fn(),
    VERBOSE: false,
  };
});

const runnerInstances: Array<{ stepId: string; run: Mock }> = [];

vi.mock('../../lib/runner.js', () => ({
  Runner: vi.fn().mockImplementation((_, stepId: string) => {
    const instance = { stepId, run: vi.fn() };
    runnerInstances.push(instance);
    return instance;
  }),
}));

vi.mock('../../lib/acp-runner.js', () => ({
  ACPRunner: vi.fn(),
}));

vi.mock('../../lib/agents/index.js', () => ({
  createAgent: vi.fn().mockReturnValue({ getLogSources: () => [] }),
}));

import { launch } from 'rover-core';
import { runCommand } from '../run.js';
import { Runner } from '../../lib/runner.js';

const LOOP_WORKFLOW_YAML = `
version: "1.0"
name: test-loop-resume
description: Loop resume integration workflow
defaults:
  tool: codex
steps:
  - id: step1
    type: agent
    name: Step 1
    prompt: "Initial step"
    outputs:
      - name: result1
        description: Initial result
        type: string
  - id: test_loop
    type: loop
    name: Test Loop
    until: steps.run_tests.outputs.exit_code == 0
    maxIterations: 3
    steps:
      - id: run_tests
        type: command
        name: Run Tests
        command: npm test
      - id: fix_agent
        type: agent
        name: Fix Agent
        if: steps.run_tests.outputs.exit_code != 0
        prompt: "Fix the failure: {{steps.run_tests.outputs.stderr}}"
        outputs:
          - name: patch
            description: Patch result
            type: string
  - id: step3
    type: agent
    name: Step 3
    prompt: "Finalize using {{steps.step1.outputs.result1}}"
    outputs:
      - name: result3
        description: Final result
        type: string
`;

const NESTED_LOOP_WORKFLOW_YAML = `
version: "1.0"
name: test-nested-loop-resume
description: Nested loop resume integration workflow
defaults:
  tool: codex
steps:
  - id: step1
    type: agent
    name: Step 1
    prompt: "Initial step"
    outputs:
      - name: result1
        description: Initial result
        type: string
  - id: outer_loop
    type: loop
    name: Outer Loop
    until: steps.inner_cmd.outputs.exit_code == 0
    maxIterations: 2
    steps:
      - id: inner_loop
        type: loop
        name: Inner Loop
        until: steps.inner_cmd.outputs.exit_code == 0
        maxIterations: 2
        steps:
          - id: inner_cmd
            type: command
            name: Inner Command
            command: npm test
          - id: inner_fix
            type: agent
            name: Inner Fix
            if: steps.inner_cmd.outputs.exit_code != 0
            prompt: "Fix inner failure: {{steps.inner_cmd.outputs.stderr}}"
            outputs:
              - name: patch
                description: Patch result
                type: string
  - id: step3
    type: agent
    name: Step 3
    prompt: "Finalize nested loop workflow"
    outputs:
      - name: result3
        description: Final result
        type: string
`;

function makeResult(
  id: string,
  success: boolean,
  outputs?: Record<string, string>
): StepResult {
  return {
    id,
    success,
    duration: 1,
    outputs: new Map(Object.entries(outputs ?? {})),
  };
}

describe('run command: loop checkpoint resume integration', () => {
  let tempDir: string;
  let workflowPath: string;
  let outputDir: string;
  let statusPath: string;
  let capturedExitCode: number | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    capturedExitCode = undefined;
    tempDir = mkdtempSync(join(tmpdir(), 'rover-loop-resume-test-'));
    outputDir = join(tempDir, 'output');
    mkdirSync(outputDir, { recursive: true });
    statusPath = join(tempDir, 'status.json');
    workflowPath = join(tempDir, 'workflow.yaml');
    writeFileSync(workflowPath, LOOP_WORKFLOW_YAML, 'utf8');

    runnerInstances.length = 0;
    vi.mocked(launch).mockReset();
    (Runner as unknown as Mock).mockClear();

    vi.spyOn(process, 'exit').mockImplementation(
      (code?: string | number | null | undefined) => {
        capturedExitCode = Number(code ?? 0);
        return undefined as never;
      }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(process.exit).mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resumes a real loop from saved loop progress and completes the workflow', async () => {
    const checkpointPath = join(outputDir, 'checkpoint.json');
    writeFileSync(
      checkpointPath,
      JSON.stringify(
        {
          completedSteps: [{ id: 'step1', outputs: { result1: 'hello' } }],
          loopProgress: {
            test_loop: {
              iteration: 1,
              nextSubStepIndex: 1,
              subStepOutputs: {
                run_tests: {
                  exit_code: '1',
                  stderr: 'failing tests',
                },
              },
              skippedSubSteps: [],
            },
          },
          failedStepId: 'fix_agent',
          error: 'Rate limit exceeded',
          isRetryable: true,
        },
        null,
        2
      ),
      'utf8'
    );

    (Runner as unknown as Mock).mockImplementation((_, stepId: string) => {
      const resultByStepId: Record<string, StepResult> = {
        fix_agent: makeResult('fix_agent', true, { patch: 'applied' }),
        step3: makeResult('step3', true, { result3: 'done' }),
      };
      const instance = {
        stepId,
        run: vi.fn().mockResolvedValue(resultByStepId[stepId]),
      };
      runnerInstances.push(instance);
      return instance;
    });

    vi.mocked(launch).mockResolvedValue({
      exitCode: 0,
      stdout: 'PASS',
      stderr: '',
    } as never);

    const promise = runCommand(workflowPath, {
      input: [],
      output: outputDir,
      taskId: 'loop-task-1',
      statusFile: statusPath,
      checkpoint: checkpointPath,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(capturedExitCode).toBe(0);
    expect(runnerInstances.map(instance => instance.stepId)).toEqual([
      'fix_agent',
      'step3',
    ]);
    expect(launch).toHaveBeenCalledTimes(1);

    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    expect(status.status).toBe('completed');

    expect(existsSync(checkpointPath)).toBe(false);
  });

  it('resumes a nested loop from saved inner loop progress and clears the checkpoint on success', async () => {
    writeFileSync(workflowPath, NESTED_LOOP_WORKFLOW_YAML, 'utf8');

    const checkpointPath = join(outputDir, 'checkpoint.json');
    writeFileSync(
      checkpointPath,
      JSON.stringify(
        {
          completedSteps: [{ id: 'step1', outputs: { result1: 'hello' } }],
          loopProgress: {
            outer_loop: {
              iteration: 1,
              nextSubStepIndex: 0,
              subStepOutputs: {},
              skippedSubSteps: [],
            },
            inner_loop: {
              iteration: 1,
              nextSubStepIndex: 1,
              subStepOutputs: {
                inner_cmd: {
                  exit_code: '1',
                  stderr: 'inner failing tests',
                },
              },
              skippedSubSteps: [],
            },
          },
          failedStepId: 'inner_fix',
          error: 'Rate limit exceeded',
          isRetryable: true,
        },
        null,
        2
      ),
      'utf8'
    );

    (Runner as unknown as Mock).mockImplementation((_, stepId: string) => {
      const resultByStepId: Record<string, StepResult> = {
        inner_fix: makeResult('inner_fix', true, { patch: 'nested applied' }),
        step3: makeResult('step3', true, { result3: 'nested done' }),
      };
      const instance = {
        stepId,
        run: vi.fn().mockResolvedValue(resultByStepId[stepId]),
      };
      runnerInstances.push(instance);
      return instance;
    });

    vi.mocked(launch).mockResolvedValue({
      exitCode: 0,
      stdout: 'PASS',
      stderr: '',
    } as never);

    const promise = runCommand(workflowPath, {
      input: [],
      output: outputDir,
      taskId: 'nested-loop-task-1',
      statusFile: statusPath,
      checkpoint: checkpointPath,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(capturedExitCode).toBe(0);
    expect(runnerInstances.map(instance => instance.stepId)).toEqual([
      'inner_fix',
      'step3',
    ]);
    expect(launch).toHaveBeenCalledTimes(1);

    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    expect(status.status).toBe('completed');
    expect(existsSync(checkpointPath)).toBe(false);
  });
});
