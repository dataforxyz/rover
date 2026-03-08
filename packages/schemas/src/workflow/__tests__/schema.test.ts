import { describe, expect, it } from 'vitest';
import { WorkflowSchema } from '../schema.js';

describe('WorkflowSchema', () => {
  it('accepts supported step types', () => {
    const result = WorkflowSchema.parse({
      version: '1.0',
      name: 'test-workflow',
      description: 'test workflow',
      steps: [
        {
          id: 'run-agent',
          name: 'Run agent',
          type: 'agent',
          prompt: 'Do the thing',
        },
        {
          id: 'repeat',
          name: 'Repeat',
          type: 'loop',
          until: 'steps.run-agent.outputs.done == true',
          steps: [
            {
              id: 'run-command',
              name: 'Run command',
              type: 'command',
              command: 'echo',
              args: ['hello'],
            },
          ],
        },
      ],
    });

    expect(result.steps).toHaveLength(2);
  });

  it('rejects legacy conditional step types until runtime support exists', () => {
    expect(() =>
      WorkflowSchema.parse({
        version: '1.0',
        name: 'legacy-workflow',
        description: 'legacy workflow',
        steps: [
          {
            id: 'branch',
            name: 'Branch',
            type: 'conditional',
            condition: 'true',
            then: [],
          },
        ],
      })
    ).toThrow();
  });

  it('rejects legacy parallel step types nested inside loops', () => {
    expect(() =>
      WorkflowSchema.parse({
        version: '1.0',
        name: 'nested-legacy-workflow',
        description: 'nested legacy workflow',
        steps: [
          {
            id: 'repeat',
            name: 'Repeat',
            type: 'loop',
            until: 'steps.run-agent.outputs.done == true',
            steps: [
              {
                id: 'parallel-work',
                name: 'Parallel work',
                type: 'parallel',
                steps: [],
              },
            ],
          },
        ],
      })
    ).toThrow();
  });

  it('rejects truly invalid step types', () => {
    expect(() =>
      WorkflowSchema.parse({
        version: '1.0',
        name: 'invalid-workflow',
        description: 'invalid workflow',
        steps: [
          {
            id: 'bad',
            name: 'Bad step',
            type: 'nonexistent',
          },
        ],
      })
    ).toThrow();
  });

  it('rejects conditions that use unsupported && operators', () => {
    expect(() =>
      WorkflowSchema.parse({
        version: '1.0',
        name: 'invalid-condition-workflow',
        description: 'invalid condition workflow',
        steps: [
          {
            id: 'run-agent',
            name: 'Run agent',
            type: 'agent',
            prompt: 'Do the thing',
            if: 'steps.a.outputs.ok == true && steps.b.outputs.ok == true',
          },
        ],
      })
    ).toThrow();
  });
});
