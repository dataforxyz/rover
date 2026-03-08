import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { TaskDescriptionManager } from 'rover-core';

describe('rover resume lock contention (e2e)', () => {
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

  const createMockDocker = () => {
    const scriptPath = join(mockBinDir, 'docker');
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash
set -euo pipefail

if [[ "\${1:-}" == "info" && "\${2:-}" == "--format" && "\${3:-}" == "json" ]]; then
  echo '{"ServerVersion":"24.0.0"}'
  exit 0
fi

if [[ "\${1:-}" == "image" && "\${2:-}" == "inspect" ]]; then
  if [[ "\${3:-}" == "--format" && "\${4:-}" == "{{.Id}}" ]]; then
    echo "sha256:mock-agent-image"
    exit 0
  fi
  echo "[]"
  exit 0
fi

if [[ "\${1:-}" == "run" && "\${2:-}" == "--entrypoint" && "\${3:-}" == "/bin/cat" ]]; then
  target="\${@: -1}"
  if [[ "$target" == "/etc/passwd" ]]; then
    echo "root:x:0:0:root:/root:/bin/sh"
    exit 0
  fi
  if [[ "$target" == "/etc/group" ]]; then
    echo "root:x:0:"
    exit 0
  fi
  exit 0
fi

if [[ "\${1:-}" == "rm" && "\${2:-}" == "-f" ]]; then
  exit 0
fi

if [[ "\${1:-}" == "create" ]]; then
  echo "mock-container-id"
  exit 0
fi

if [[ "\${1:-}" == "start" ]]; then
  echo "\${2:-mock-container-id}"
  exit 0
fi

echo "Docker version 24.0.0"
exit 0
`
    );
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

  const createPausedTask = (taskId: number) => {
    const taskDir = join(testDir, '.rover', 'tasks', taskId.toString());
    const task = TaskDescriptionManager.create(taskDir, {
      id: taskId,
      title: 'Paused task',
      description: 'Task for resume lock contention test',
      inputs: new Map(),
      workflowName: 'swe',
    });
    task.markInProgress();
    task.markPaused('rate limit');
    return task;
  };

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalPath = process.env.PATH || '';

    testDir = mkdtempSync(join(tmpdir(), 'rover-resume-lock-e2e-'));
    process.chdir(testDir);

    mockBinDir = join(testDir, '.mock-bin');
    mkdirSync(mockBinDir, { recursive: true });

    mockHomeDir = join(testDir, '.mock-home');
    mkdirSync(mockHomeDir, { recursive: true });
    writeFileSync(
      join(mockHomeDir, '.claude.json'),
      JSON.stringify({ version: 1 })
    );

    process.env.PATH = `${mockBinDir}:${originalPath}`;

    createMockDocker();
    createMockTool('claude', 0, 'Claude CLI v1.0.0');
    createMockTool('codex', 127, 'command not found: codex');
    createMockTool('cursor', 127, 'command not found: cursor');
    createMockTool('cursor-agent', 127, 'command not found: cursor-agent');
    createMockTool('gemini', 127, 'command not found: gemini');
    createMockTool('qwen', 127, 'command not found: qwen');
    createMockTool('opencode', 127, 'command not found: opencode');

    await execa('git', ['init']);
    await execa('git', ['config', 'user.email', 'test@test.com']);
    await execa('git', ['config', 'user.name', 'Test User']);
    await execa('git', ['config', 'commit.gpgsign', 'false']);

    writeFileSync(
      'package.json',
      JSON.stringify(
        { name: 'test-project', version: '1.0.0', type: 'module' },
        null,
        2
      )
    );
    writeFileSync('README.md', '# Test Project\n');

    await execa('git', ['add', '.']);
    await execa('git', ['commit', '-m', 'Initial commit']);

    await runRover(['init', '--yes']);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects resume when lock is held by another live process', async () => {
    const taskId = 1;
    const task = createPausedTask(taskId);

    const iterationPath = join(task.iterationsPath(), '1');
    mkdirSync(iterationPath, { recursive: true });
    const lockPath = join(iterationPath, '.resume.lock');

    const lockHolder = execa(
      'node',
      [
        '-e',
        `
const fs = require('node:fs');
const lockPath = process.argv[1];
fs.writeFileSync(lockPath, process.pid + ':' + Date.now(), { flag: 'wx' });
setInterval(() => {}, 1000);
`,
        lockPath,
      ],
      {
        cwd: testDir,
        env: { ...process.env },
        reject: false,
      }
    );

    try {
      const start = Date.now();
      while (!existsSync(lockPath) && Date.now() - start < 2000) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }

      expect(existsSync(lockPath)).toBe(true);

      const result = await runRover(['resume', '1', '--json']);
      const combinedOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

      expect(result.exitCode).not.toBe(0);
      expect(combinedOutput).toContain('already being resumed');
    } finally {
      lockHolder.kill('SIGTERM');
      await lockHolder.catch(() => undefined);
    }
  });

  it('returns already-resuming for many concurrent callers while a lock holder is active', async () => {
    const taskId = 2;
    const task = createPausedTask(taskId);
    const iterationPath = join(task.iterationsPath(), '1');
    mkdirSync(iterationPath, { recursive: true });
    const lockPath = join(iterationPath, '.resume.lock');

    const lockHolder = execa(
      'node',
      [
        '-e',
        `
const fs = require('node:fs');
const lockPath = process.argv[1];
fs.writeFileSync(lockPath, process.pid + ':' + Date.now(), { flag: 'wx' });
setInterval(() => {}, 1000);
`,
        lockPath,
      ],
      {
        cwd: testDir,
        env: { ...process.env },
        reject: false,
      }
    );

    try {
      const start = Date.now();
      while (!existsSync(lockPath) && Date.now() - start < 2000) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }

      const attempts = await Promise.all(
        Array.from({ length: 8 }, () =>
          runRover(['resume', String(taskId), '--json'])
        )
      );

      for (const result of attempts) {
        expect(result.exitCode).not.toBe(0);
        const combinedOutput =
          `${result.stdout}\n${result.stderr}`.toLowerCase();
        expect(combinedOutput).toContain('already being resumed');
      }
    } finally {
      lockHolder.kill('SIGTERM');
      await lockHolder.catch(() => undefined);
    }
  });

  it('recovers from a stale lock left by a crashed process', async () => {
    const taskId = 3;
    const task = createPausedTask(taskId);

    const iterationPath = join(task.iterationsPath(), '1');
    mkdirSync(iterationPath, { recursive: true });
    const lockPath = join(iterationPath, '.resume.lock');

    // Simulate a stale lock from a crashed process.
    writeFileSync(lockPath, '99999999:1', 'utf8');

    const result = await runRover(['resume', String(taskId), '--json']);
    const combinedOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
    expect(combinedOutput).not.toContain('already being resumed');
    expect(existsSync(lockPath)).toBe(false);
  });
});
