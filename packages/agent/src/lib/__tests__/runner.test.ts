import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowOutput } from 'rover-schemas';
import { Runner } from '../runner.js';
import { launch, launchSync } from 'rover-core';

vi.mock('rover-core', async () => {
  const actual = await vi.importActual<any>('rover-core');
  return {
    ...actual,
    launch: vi.fn(),
    launchSync: vi.fn(),
  };
});

vi.mock('../agents/index.js', () => ({
  createAgent: vi.fn(() => ({
    binary: 'claude',
    directArguments: () => [],
    extractUsageStats: () => undefined,
  })),
  Agent: class {},
}));

describe('Runner string output extraction', () => {
  const workflowStep = {
    id: 'write_tests',
    type: 'agent',
    name: 'Write Tests',
    prompt: 'Write tests',
    outputs: [] as WorkflowOutput[],
  };

  const workflow = {
    defaults: { tool: 'claude' },
    getStep: vi.fn(() => workflowStep),
    getStepTool: vi.fn(() => 'claude'),
    getStepTimeout: vi.fn(() => 120),
  } as any;

  beforeEach(() => {
    vi.mocked(launchSync).mockReset();
    vi.mocked(launch).mockReset();
    vi.mocked(launchSync).mockReturnValue({ stdout: Buffer.from('1.0.0') } as any);
    workflowStep.outputs = [];
  });

  it('falls back to the raw response for a single required string output', async () => {
    workflowStep.outputs = [
      {
        name: 'test_changes_markdown',
        type: 'string',
        description: 'Description of tests written',
        required: true,
      } as WorkflowOutput,
    ];

    const runner = new Runner(
      workflow,
      'write_tests',
      new Map(),
      new Map(),
      'claude',
      undefined
    );

    const outputs = new Map<string, string>();
    await (runner as any).extractStringOutputs(
      '## Tests Added\n\n- Added coverage for icon widgets',
      workflowStep.outputs,
      outputs
    );

    expect(outputs.get('test_changes_markdown')).toContain('## Tests Added');
    expect(launch).not.toHaveBeenCalled();
  });

  it('asks the agent one more time with strict JSON when required outputs are missing', async () => {
    workflowStep.outputs = [
      {
        name: 'changes_markdown',
        type: 'string',
        description: 'Summary of code changes',
        required: true,
      } as WorkflowOutput,
      {
        name: 'summary_markdown',
        type: 'string',
        description: 'Short summary',
        required: true,
      } as WorkflowOutput,
    ];

    vi.mocked(launch).mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(
        '{"changes_markdown":"Fixed auth flow","summary_markdown":"Done"}'
      ),
    } as any);

    const runner = new Runner(
      workflow,
      'write_tests',
      new Map(),
      new Map(),
      'claude',
      undefined
    );

    const outputs = new Map<string, string>();
    await (runner as any).extractStringOutputs(
      'Here is what I changed in prose only.',
      workflowStep.outputs,
      outputs
    );

    expect(outputs.get('changes_markdown')).toBe('Fixed auth flow');
    expect(outputs.get('summary_markdown')).toBe('Done');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(launch).mock.calls[0]?.[2]?.input || '')).toContain(
      'Rewrite it as a valid JSON object only'
    );
  });
});
