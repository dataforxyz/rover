import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ACPRunner } from '../acp-runner.js';

// Mock clearAllTerminals so close() doesn't interact with real terminal state
vi.mock('../acp-client.js', () => ({
  ACPClient: vi.fn().mockImplementation(() => ({
    startCapturing: vi.fn(),
    stopCapturing: vi.fn().mockReturnValue(''),
    getLastPromptCost: vi.fn().mockReturnValue({ amount: 0, currency: 'USD' }),
    resetCost: vi.fn(),
  })),
  clearAllTerminals: vi.fn(),
}));

describe('ACPRunner', () => {
  it('applies the workflow default model when ACP steps use the workflow default tool', async () => {
    const step = {
      id: 'step-1',
      name: 'Generate',
      type: 'agent',
      prompt: 'Write code',
    };
    const workflow = {
      defaults: { tool: 'claude', model: 'sonnet' },
      steps: [step],
      getStep: vi.fn().mockReturnValue(step),
    };

    const runner = new ACPRunner({
      workflow: workflow as any,
      inputs: new Map(),
    });

    (runner as any).isConnectionInitialized = true;
    (runner as any).isSessionCreated = true;
    (runner as any).connection = {};
    (runner as any).sessionId = 'session-1';
    const setModelSpy = vi.spyOn(runner, 'setModel').mockResolvedValue();
    (runner as any).buildACPPrompt = vi.fn().mockReturnValue('prompt');
    (runner as any).sendPrompt = vi.fn().mockResolvedValue({
      tokens: 1,
      cost: 0,
      stopReason: 'end_turn',
      response: [],
    });
    (runner as any).parseStepOutputs = vi.fn().mockResolvedValue({
      success: true,
    });

    await runner.runStep('step-1');

    expect(setModelSpy).toHaveBeenCalledWith('sonnet');
  });

  it('does not apply the workflow default model to a step that overrides the tool', async () => {
    const step = {
      id: 'step-1',
      name: 'Generate',
      type: 'agent',
      tool: 'qwen',
      prompt: 'Write code',
    };
    const workflow = {
      defaults: { tool: 'claude', model: 'sonnet' },
      steps: [step],
      getStep: vi.fn().mockReturnValue(step),
    };

    const runner = new ACPRunner({
      workflow: workflow as any,
      inputs: new Map(),
    });

    (runner as any).isConnectionInitialized = true;
    (runner as any).isSessionCreated = true;
    (runner as any).connection = {};
    (runner as any).sessionId = 'session-1';
    const setModelSpy = vi.spyOn(runner, 'setModel').mockResolvedValue();
    (runner as any).buildACPPrompt = vi.fn().mockReturnValue('prompt');
    (runner as any).sendPrompt = vi.fn().mockResolvedValue({
      tokens: 1,
      cost: 0,
      stopReason: 'end_turn',
      response: [],
    });
    (runner as any).parseStepOutputs = vi.fn().mockResolvedValue({
      success: true,
    });

    await runner.runStep('step-1');

    expect(setModelSpy).not.toHaveBeenCalled();
  });

  it('computes progress from executable workflow positions for nested loop steps', async () => {
    const nestedStep = {
      id: 'nested-agent',
      name: 'Nested Generate',
      type: 'agent',
      prompt: 'Write code',
    };
    const workflow = {
      defaults: { tool: 'claude', model: 'sonnet' },
      steps: [
        {
          id: 'outer-loop',
          name: 'Outer Loop',
          type: 'loop',
          maxIterations: 1,
          steps: [nestedStep],
        },
        {
          id: 'final-step',
          name: 'Final Step',
          type: 'agent',
          prompt: 'Finish up',
        },
      ],
      getStep: vi.fn().mockReturnValue(nestedStep),
    };
    const statusManager = {
      update: vi.fn(),
    };
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    const runner = new ACPRunner({
      workflow: workflow as any,
      inputs: new Map(),
      statusManager: statusManager as any,
      logger: logger as any,
    });

    (runner as any).isConnectionInitialized = true;
    (runner as any).isSessionCreated = true;
    (runner as any).connection = {};
    (runner as any).sessionId = 'session-1';
    vi.spyOn(runner, 'setModel').mockResolvedValue();
    (runner as any).buildACPPrompt = vi.fn().mockReturnValue('prompt');
    (runner as any).sendPrompt = vi.fn().mockResolvedValue({
      tokens: 1,
      cost: 0,
      stopReason: 'end_turn',
      response: [],
    });
    (runner as any).parseStepOutputs = vi.fn().mockResolvedValue({
      success: true,
    });

    await runner.runStep('nested-agent');

    expect(statusManager.update).toHaveBeenNthCalledWith(
      1,
      'running',
      'Nested Generate',
      0
    );
    expect(statusManager.update).toHaveBeenNthCalledWith(
      2,
      'running',
      'Nested Generate',
      50
    );
    expect(logger.info).toHaveBeenCalledWith(
      'step_start',
      'Starting step: Nested Generate',
      expect.objectContaining({ progress: 0 })
    );
  });
});

describe('ACPRunner.close', () => {
  it('sends SIGTERM to the agent process and clears terminals', async () => {
    const { clearAllTerminals } = await import('../acp-client.js');

    const workflow = {
      defaults: { tool: 'claude' },
      steps: [],
      getStep: vi.fn(),
    };

    const runner = new ACPRunner({
      workflow: workflow as any,
      inputs: new Map(),
    });

    // Create a fake ChildProcess with a kill spy
    const killSpy = vi.fn();
    const fakeProcess = {
      kill: killSpy,
      stdin: { destroy: vi.fn() },
      stdout: { destroy: vi.fn() },
      stderr: { destroy: vi.fn() },
    };

    (runner as any).agentProcess = fakeProcess;
    (runner as any).isConnectionInitialized = true;
    (runner as any).connection = {};
    (runner as any).sessionId = 'session-abc';
    (runner as any).isSessionCreated = true;

    runner.close();

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(clearAllTerminals).toHaveBeenCalled();
    // Internal state should be reset
    expect((runner as any).agentProcess).toBeNull();
    expect((runner as any).connection).toBeNull();
    expect((runner as any).sessionId).toBeNull();
    expect((runner as any).isConnectionInitialized).toBe(false);
    expect((runner as any).isSessionCreated).toBe(false);
  });

  it('calls clearAllTerminals even when no agent process is running', async () => {
    const { clearAllTerminals } = await import('../acp-client.js');
    vi.mocked(clearAllTerminals).mockClear();

    const workflow = {
      defaults: { tool: 'claude' },
      steps: [],
      getStep: vi.fn(),
    };

    const runner = new ACPRunner({
      workflow: workflow as any,
      inputs: new Map(),
    });

    // agentProcess is null by default
    runner.close();

    expect(clearAllTerminals).toHaveBeenCalled();
  });
});

describe('ACPRunner extractJsonFromContent', () => {
  let runner: ACPRunner;

  beforeEach(() => {
    const workflow = {
      defaults: { tool: 'claude' },
      steps: [],
      getStep: vi.fn(),
    };
    runner = new ACPRunner({ workflow: workflow as any, inputs: new Map() });
  });

  it('extracts JSON from a fenced code block', () => {
    const content = 'Some text\n```json\n{"key": "value"}\n```\nMore text';
    const result = (runner as any).extractJsonFromContent(content);
    expect(result).toEqual({ key: 'value' });
  });

  it('extracts inline JSON object from plain text', () => {
    const content = 'The result is {"skipped": "true"} as expected.';
    const result = (runner as any).extractJsonFromContent(content);
    expect(result).toEqual({ skipped: 'true' });
  });

  it('extracts inline JSON with boolean values', () => {
    const content = 'Outcome: {"issues_found": true}';
    const result = (runner as any).extractJsonFromContent(content);
    expect(result).toEqual({ issues_found: true });
  });

  it('extracts inline JSON with numeric values', () => {
    const content = 'Stats: {"count": 42}';
    const result = (runner as any).extractJsonFromContent(content);
    expect(result).toEqual({ count: 42 });
  });

  it('returns null when content contains no JSON', () => {
    const content = 'This is plain text with no JSON object.';
    const result = (runner as any).extractJsonFromContent(content);
    expect(result).toBeNull();
  });

  it('returns null when a JSON code block contains invalid JSON', () => {
    const content = '```json\n{invalid json here}\n```';
    const result = (runner as any).extractJsonFromContent(content);
    // The inline fallback also won't match malformed JSON
    expect(result).toBeNull();
  });

  it('prefers the JSON code block over inline JSON when both are present', () => {
    const content = '```json\n{"from": "block"}\n```\nAlso {"from": "inline"}';
    const result = (runner as any).extractJsonFromContent(content);
    expect(result).toEqual({ from: 'block' });
  });
});

describe('ACPRunner session lifecycle', () => {
  it('createSession calls connection.newSession and stores the session id', async () => {
    const workflow = {
      defaults: { tool: 'claude' },
      steps: [],
      getStep: vi.fn(),
    };

    const runner = new ACPRunner({
      workflow: workflow as any,
      inputs: new Map(),
    });

    const newSessionMock = vi.fn().mockResolvedValue({ sessionId: 'sess-42' });
    (runner as any).isConnectionInitialized = true;
    (runner as any).connection = { newSession: newSessionMock };

    const sessionId = await runner.createSession('/workspace');

    expect(newSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspace' })
    );
    expect(sessionId).toBe('sess-42');
    expect((runner as any).sessionId).toBe('sess-42');
    expect((runner as any).isSessionCreated).toBe(true);
  });

  it('createSession throws when called a second time without closing', async () => {
    const workflow = {
      defaults: { tool: 'claude' },
      steps: [],
      getStep: vi.fn(),
    };

    const runner = new ACPRunner({
      workflow: workflow as any,
      inputs: new Map(),
    });

    (runner as any).isConnectionInitialized = true;
    (runner as any).connection = {
      newSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1' }),
    };

    await runner.createSession();
    await expect(runner.createSession()).rejects.toThrow(
      'Session already created'
    );
  });

  it('createSession throws when the connection has not been initialized', async () => {
    const workflow = {
      defaults: { tool: 'claude' },
      steps: [],
      getStep: vi.fn(),
    };

    const runner = new ACPRunner({
      workflow: workflow as any,
      inputs: new Map(),
    });

    await expect(runner.createSession()).rejects.toThrow(
      'Connection not initialized'
    );
  });

  it('closeSession calls connection.endSession and resets session state', async () => {
    const workflow = {
      defaults: { tool: 'claude' },
      steps: [],
      getStep: vi.fn(),
    };

    const runner = new ACPRunner({
      workflow: workflow as any,
      inputs: new Map(),
    });

    const endSessionMock = vi.fn().mockResolvedValue({});
    const resetCostMock = vi.fn();
    (runner as any).isConnectionInitialized = true;
    (runner as any).isSessionCreated = true;
    (runner as any).connection = { endSession: endSessionMock };
    (runner as any).sessionId = 'sess-99';
    (runner as any).client = { resetCost: resetCostMock };

    runner.closeSession();

    // endSession is fire-and-forget so we just verify it was invoked
    expect(endSessionMock).toHaveBeenCalledWith({ sessionId: 'sess-99' });
    expect((runner as any).sessionId).toBeNull();
    expect((runner as any).isSessionCreated).toBe(false);
    expect(resetCostMock).toHaveBeenCalled();
  });

  it('closeSession is a no-op when no session is active', () => {
    const workflow = {
      defaults: { tool: 'claude' },
      steps: [],
      getStep: vi.fn(),
    };

    const runner = new ACPRunner({
      workflow: workflow as any,
      inputs: new Map(),
    });

    // Should not throw
    expect(() => runner.closeSession()).not.toThrow();
    expect((runner as any).isSessionCreated).toBe(false);
  });
});

describe('flattenLeafStepIds', () => {
  it('collects IDs of flat (non-loop) steps', () => {
    const stepB = { id: 'step-b', name: 'B', type: 'agent', prompt: 'do b' };
    const workflow = {
      defaults: { tool: 'claude' },
      steps: [
        { id: 'step-a', name: 'A', type: 'agent', prompt: 'do a' },
        stepB,
      ],
      getStep: vi.fn().mockReturnValue(stepB),
    };

    const runner = new ACPRunner({
      workflow: workflow as any,
      inputs: new Map(),
    });

    // Exercise via runStep which internally calls flattenLeafStepIds
    // Instead, test indirectly through the progress calculation exposed by
    // statusManager calls when running a known step.
    const statusManager = { update: vi.fn() };
    (runner as any).statusManager = statusManager;
    (runner as any).isConnectionInitialized = true;
    (runner as any).isSessionCreated = true;
    (runner as any).connection = {};
    (runner as any).sessionId = 'sess-flat';

    vi.spyOn(runner, 'setModel').mockResolvedValue();
    (runner as any).buildACPPrompt = vi.fn().mockReturnValue('prompt');
    (runner as any).sendPrompt = vi.fn().mockResolvedValue({
      tokens: 1,
      cost: 0,
      stopReason: 'end_turn',
      response: '{}',
    });
    (runner as any).parseStepOutputs = vi
      .fn()
      .mockResolvedValue({ success: true });

    // Run step-b (index 1 of 2 leaf steps -> 50% start, 100% end)
    return runner.runStep('step-b').then(() => {
      expect(statusManager.update).toHaveBeenNthCalledWith(
        1,
        'running',
        'B',
        50
      );
      expect(statusManager.update).toHaveBeenNthCalledWith(
        2,
        'running',
        'B',
        100
      );
    });
  });

  it('skips loop container IDs and flattens their child steps', () => {
    const innerStep = {
      id: 'inner',
      name: 'Inner',
      type: 'agent',
      prompt: 'inner prompt',
    };
    const workflow = {
      defaults: { tool: 'claude' },
      steps: [
        {
          id: 'loop-1',
          name: 'Loop',
          type: 'loop',
          maxIterations: 1,
          steps: [innerStep],
        },
        { id: 'after-loop', name: 'After', type: 'agent', prompt: 'after' },
      ],
      getStep: vi.fn().mockReturnValue(innerStep),
    };

    const statusManager = { update: vi.fn() };

    const runner = new ACPRunner({
      workflow: workflow as any,
      inputs: new Map(),
      statusManager: statusManager as any,
    });

    (runner as any).isConnectionInitialized = true;
    (runner as any).isSessionCreated = true;
    (runner as any).connection = {};
    (runner as any).sessionId = 'sess-loop';

    vi.spyOn(runner, 'setModel').mockResolvedValue();
    (runner as any).buildACPPrompt = vi.fn().mockReturnValue('prompt');
    (runner as any).sendPrompt = vi.fn().mockResolvedValue({
      tokens: 1,
      cost: 0,
      stopReason: 'end_turn',
      response: '{}',
    });
    (runner as any).parseStepOutputs = vi
      .fn()
      .mockResolvedValue({ success: true });

    // 'inner' is index 0 of ['inner', 'after-loop'] -> 0% start progress
    return runner.runStep('inner').then(() => {
      expect(statusManager.update).toHaveBeenNthCalledWith(
        1,
        'running',
        'Inner',
        0
      );
    });
  });
});
