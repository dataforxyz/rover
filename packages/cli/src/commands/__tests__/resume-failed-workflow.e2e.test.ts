import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { SKIP_REAL_AGENT_TESTS } from './e2e-utils.js';

describe.skipIf(SKIP_REAL_AGENT_TESTS)(
  'rover resume from natural failed workflow (e2e)',
  () => {
    let testDir: string;
    let originalCwd: string;
    let mockBinDir: string;
    let mockHomeDir: string;
    let originalPath: string;

    const roverBin = join(__dirname, '../../../dist/index.mjs');

    const createMockTool = (
      toolName: string,
      exitCode: number = 0,
      output: string = 'mock version 1.0.0'
    ) => {
      const scriptPath = join(mockBinDir, toolName);
      const scriptContent = `#!/usr/bin/env bash\necho "${output}"\nexit ${exitCode}`;
      writeFileSync(scriptPath, scriptContent);
      chmodSync(scriptPath, 0o755);
    };

    const runRover = async (args: string[]) => {
      const testPath = `${mockBinDir}:${originalPath}`;
      return execa('node', [roverBin, ...args], {
        cwd: testDir,
        env: {
          PATH: testPath,
          HOME: mockHomeDir,
          USER: process.env.USER,
          TMPDIR: process.env.TMPDIR,
          ROVER_NO_TELEMETRY: '1',
        },
        reject: false,
      });
    };

    const waitForTaskStatus = async (
      taskId: number,
      expectedStatuses: string[],
      timeoutMs: number = 180000
    ): Promise<string> => {
      const start = Date.now();

      while (Date.now() - start < timeoutMs) {
        // list triggers orphan/status reconciliation before emitting task rows.
        const listResult = await runRover(['list', '--json']);
        if (listResult.exitCode === 0) {
          try {
            const tasks = JSON.parse(listResult.stdout) as Array<{
              id: number;
              status: string;
            }>;
            const task = tasks.find(t => t.id === taskId);
            if (task && expectedStatuses.includes(task.status)) {
              return task.status;
            }
          } catch {
            // Keep polling until timeout
          }
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      throw new Error(
        `Timed out waiting for task ${taskId} status in [${expectedStatuses.join(', ')}]`
      );
    };

    beforeEach(async () => {
      originalCwd = process.cwd();
      originalPath = process.env.PATH || '';

      testDir = mkdtempSync(join(tmpdir(), 'rover-resume-failed-e2e-'));
      process.chdir(testDir);

      mockBinDir = join(testDir, '.mock-bin');
      mkdirSync(mockBinDir, { recursive: true });

      mockHomeDir = join(testDir, '.mock-home');
      mkdirSync(mockHomeDir, { recursive: true });
      writeFileSync(
        join(mockHomeDir, '.claude.json'),
        JSON.stringify({ version: 1 })
      );

      // Keep real Docker/Claude available while still controlling HOME.
      // Other providers are stubbed so environment checks remain predictable.
      createMockTool('codex', 127, 'command not found: codex');
      createMockTool('cursor', 127, 'command not found: cursor');
      createMockTool('cursor-agent', 127, 'command not found: cursor-agent');
      createMockTool('gemini', 127, 'command not found: gemini');
      createMockTool('qwen', 127, 'command not found: qwen');
      createMockTool('opencode', 127, 'command not found: opencode');

      process.env.PATH = `${mockBinDir}:${originalPath}`;

      await execa('git', ['init']);
      await execa('git', ['config', 'user.email', 'test@test.com']);
      await execa('git', ['config', 'user.name', 'Test User']);
      await execa('git', ['config', 'commit.gpgsign', 'false']);

      writeFileSync(
        'package.json',
        JSON.stringify(
          {
            name: 'resume-failed-e2e-project',
            version: '1.0.0',
            type: 'module',
          },
          null,
          2
        )
      );
      writeFileSync('README.md', '# Resume Failed E2E Test\n');

      await execa('git', ['add', '.']);
      await execa('git', ['commit', '-m', 'Initial commit']);

      const initResult = await runRover(['init', '--yes']);
      expect(initResult.exitCode).toBe(0);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
      rmSync(testDir, { recursive: true, force: true });
    });

    it('resumes a naturally failed task produced by a deterministic command workflow', async () => {
      const workflowPath = join(testDir, 'fail-fast.yml');
      writeFileSync(
        workflowPath,
        `version: "1.0"
name: "fail-fast"
description: "Deterministic failing workflow for resume validation"
steps:
  - id: fail_step
    type: command
    name: "Intentional Failure"
    command: "sh -c 'echo intentional-failure >&2; exit 1'"
`
      );

      const addWorkflowResult = await runRover([
        'workflows',
        'add',
        workflowPath,
        '--name',
        'fail-fast-e2e',
        '--json',
      ]);
      expect(addWorkflowResult.exitCode).toBe(0);

      const createTaskResult = await runRover([
        'task',
        '-y',
        'Trigger deterministic workflow failure',
        '-w',
        'fail-fast-e2e',
        '-a',
        'claude:haiku',
        '--json',
      ]);
      expect(createTaskResult.exitCode).toBe(0);

      const created = JSON.parse(createTaskResult.stdout);
      const taskId = created.taskId as number;
      expect(taskId).toBeGreaterThan(0);

      const finalStatus = await waitForTaskStatus(taskId, ['FAILED']);
      expect(finalStatus).toBe('FAILED');

      const resumeResult = await runRover(['resume', String(taskId), '--json']);
      expect(resumeResult.exitCode).toBe(0);

      const resumed = JSON.parse(resumeResult.stdout);
      expect(resumed.success).toBe(true);
      expect(resumed.taskId).toBe(taskId);
      expect(resumed.status).toBe('IN_PROGRESS');
    });
  }
);
