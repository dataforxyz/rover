import { describe, expect, it, vi } from 'vitest';

vi.mock('rover-core/src/display/header.js', () => ({
  showRoverHeader: vi.fn(),
}));

import { createProgram } from '../../program.js';

describe('program', () => {
  it('registers the deprecated --from-gitlab task option', () => {
    const program = createProgram({ excludeRuntimeHooks: true });
    const taskCommand = program.commands.find(
      command => command.name() === 'task'
    );

    expect(taskCommand).toBeDefined();
    expect(
      taskCommand?.options.some(option => option.long === '--from-gitlab')
    ).toBe(true);
  });

  it('registers the rtk command group', () => {
    const program = createProgram({ excludeRuntimeHooks: true });
    const rtkCommand = program.commands.find(command => command.name() === 'rtk');

    expect(rtkCommand).toBeDefined();
    expect(rtkCommand?.commands.map(command => command.name())).toEqual(
      expect.arrayContaining(['status', 'enable', 'disable'])
    );
  });
});
