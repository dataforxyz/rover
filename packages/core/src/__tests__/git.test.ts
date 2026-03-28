import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Git, GitError } from '../git.js';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchSync } from '../os.js';

describe('Git', () => {
  let testDir: string;
  let git: Git;

  beforeEach(() => {
    // Create a unique test directory
    testDir = join(
      tmpdir(),
      `git-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });

    // Initialize a git repo
    launchSync('git', ['init'], { cwd: testDir });
    launchSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: testDir,
    });
    launchSync('git', ['config', 'user.name', 'Test User'], { cwd: testDir });
    launchSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: testDir });

    git = new Git({ cwd: testDir });
  });

  afterEach(() => {
    // Clean up the test directory
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('isWorktree', () => {
    it('should return false for a regular repository', () => {
      // Create an initial commit so worktrees can be created
      writeFileSync(join(testDir, 'README.md'), '# Test');
      launchSync('git', ['add', '.'], { cwd: testDir });
      launchSync('git', ['commit', '-m', 'Initial commit'], { cwd: testDir });

      expect(git.isWorktree()).toBe(false);
    });

    it('should return true when inside a worktree', () => {
      // Create an initial commit
      writeFileSync(join(testDir, 'README.md'), '# Test');
      launchSync('git', ['add', '.'], { cwd: testDir });
      launchSync('git', ['commit', '-m', 'Initial commit'], { cwd: testDir });

      // Create a worktree
      const worktreePath = join(testDir, 'my-worktree');
      launchSync('git', ['worktree', 'add', worktreePath, '-b', 'wt-branch'], {
        cwd: testDir,
      });

      const worktreeGit = new Git({ cwd: worktreePath });
      expect(worktreeGit.isWorktree()).toBe(true);

      // Cleanup
      launchSync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: testDir,
        reject: false,
      });
    });

    it('should return true from a subdirectory inside a worktree', () => {
      // Create an initial commit with a subdirectory
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export {};');
      launchSync('git', ['add', '.'], { cwd: testDir });
      launchSync('git', ['commit', '-m', 'Initial commit'], { cwd: testDir });

      // Create a worktree
      const worktreePath = join(testDir, 'my-worktree');
      launchSync('git', ['worktree', 'add', worktreePath, '-b', 'wt-branch'], {
        cwd: testDir,
      });

      const subDirGit = new Git({ cwd: join(worktreePath, 'src') });
      expect(subDirGit.isWorktree()).toBe(true);

      // Cleanup
      launchSync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: testDir,
        reject: false,
      });
    });
  });

  describe('getMainRepositoryRoot', () => {
    it('should return the same root as getRepositoryRoot for a regular repo', () => {
      writeFileSync(join(testDir, 'README.md'), '# Test');
      launchSync('git', ['add', '.'], { cwd: testDir });
      launchSync('git', ['commit', '-m', 'Initial commit'], { cwd: testDir });

      expect(git.getMainRepositoryRoot()).toBe(git.getRepositoryRoot());
    });

    it('should return the main repo root when inside a worktree', () => {
      writeFileSync(join(testDir, 'README.md'), '# Test');
      launchSync('git', ['add', '.'], { cwd: testDir });
      launchSync('git', ['commit', '-m', 'Initial commit'], { cwd: testDir });

      // Create a worktree
      const worktreePath = join(testDir, 'my-worktree');
      launchSync('git', ['worktree', 'add', worktreePath, '-b', 'wt-branch'], {
        cwd: testDir,
      });

      const worktreeGit = new Git({ cwd: worktreePath });

      // getRepositoryRoot returns the worktree path
      expect(worktreeGit.getRepositoryRoot()).toBe(worktreePath);
      // getMainRepositoryRoot returns the main repo root
      expect(worktreeGit.getMainRepositoryRoot()).toBe(testDir);

      // Cleanup
      launchSync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: testDir,
        reject: false,
      });
    });

    it('should return the main repo root from a nested subdirectory inside a worktree', () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export {};');
      launchSync('git', ['add', '.'], { cwd: testDir });
      launchSync('git', ['commit', '-m', 'Initial commit'], { cwd: testDir });

      const worktreePath = join(testDir, 'my-worktree');
      launchSync('git', ['worktree', 'add', worktreePath, '-b', 'wt-branch'], {
        cwd: testDir,
      });

      const subDirGit = new Git({ cwd: join(worktreePath, 'src') });
      expect(subDirGit.getMainRepositoryRoot()).toBe(testDir);

      // Cleanup
      launchSync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: testDir,
        reject: false,
      });
    });
  });

  describe('setupSparseCheckout', () => {
    let worktreePath: string;

    beforeEach(() => {
      // Create some test files
      writeFileSync(join(testDir, 'README.md'), '# Test Project');
      writeFileSync(join(testDir, 'public.ts'), 'export const public = true;');
      writeFileSync(
        join(testDir, 'secret.ts'),
        'export const secret = "password123";'
      );

      // Create subdirectory with files
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export * from "./app";');
      writeFileSync(join(testDir, 'src', 'app.ts'), 'export const app = {};');

      mkdirSync(join(testDir, 'internal'), { recursive: true });
      writeFileSync(
        join(testDir, 'internal', 'config.ts'),
        'export const config = {};'
      );
      writeFileSync(
        join(testDir, 'internal', 'secrets.ts'),
        'export const secrets = {};'
      );

      // Commit the files
      launchSync('git', ['add', '-A'], { cwd: testDir });
      launchSync('git', ['commit', '-m', 'Initial commit'], { cwd: testDir });

      // Create a worktree
      worktreePath = join(testDir, 'worktree');
      git.createWorktree(worktreePath, 'test-branch');
    });

    afterEach(() => {
      // Remove the worktree
      if (existsSync(worktreePath)) {
        launchSync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: testDir,
          reject: false,
        });
      }
    });

    it('should exclude files matching a simple pattern', () => {
      // Setup sparse checkout to exclude secret.ts
      git.setupSparseCheckout(worktreePath, ['secret.ts']);

      // Check that secret.ts is not in the worktree
      expect(existsSync(join(worktreePath, 'secret.ts'))).toBe(false);

      // Check that other files still exist
      expect(existsSync(join(worktreePath, 'README.md'))).toBe(true);
      expect(existsSync(join(worktreePath, 'public.ts'))).toBe(true);
      expect(existsSync(join(worktreePath, 'src', 'index.ts'))).toBe(true);
    });

    it('should exclude files matching a glob pattern', () => {
      // Setup sparse checkout to exclude all .ts files in internal/
      git.setupSparseCheckout(worktreePath, ['internal/**']);

      // Check that internal files are not in the worktree
      expect(existsSync(join(worktreePath, 'internal', 'config.ts'))).toBe(
        false
      );
      expect(existsSync(join(worktreePath, 'internal', 'secrets.ts'))).toBe(
        false
      );

      // Check that other files still exist
      expect(existsSync(join(worktreePath, 'README.md'))).toBe(true);
      expect(existsSync(join(worktreePath, 'src', 'index.ts'))).toBe(true);
    });

    it('should exclude files matching multiple patterns', () => {
      // Setup sparse checkout to exclude multiple patterns
      git.setupSparseCheckout(worktreePath, ['secret.ts', 'internal/**']);

      // Check that excluded files are not in the worktree
      expect(existsSync(join(worktreePath, 'secret.ts'))).toBe(false);
      expect(existsSync(join(worktreePath, 'internal', 'config.ts'))).toBe(
        false
      );
      expect(existsSync(join(worktreePath, 'internal', 'secrets.ts'))).toBe(
        false
      );

      // Check that other files still exist
      expect(existsSync(join(worktreePath, 'README.md'))).toBe(true);
      expect(existsSync(join(worktreePath, 'public.ts'))).toBe(true);
      expect(existsSync(join(worktreePath, 'src', 'index.ts'))).toBe(true);
    });

    it('should not show excluded files as deleted in git status', () => {
      // Setup sparse checkout
      git.setupSparseCheckout(worktreePath, ['secret.ts', 'internal/**']);

      // Check git status - excluded files should NOT appear as deleted
      const worktreeGit = new Git({ cwd: worktreePath });
      const uncommittedChanges = worktreeGit.uncommittedChanges();

      // There should be no changes - the files are simply not checked out
      expect(uncommittedChanges.length).toBe(0);
    });

    it('should do nothing when excludePatterns is empty', () => {
      // Setup sparse checkout with empty patterns
      git.setupSparseCheckout(worktreePath, []);

      // All files should still exist
      expect(existsSync(join(worktreePath, 'README.md'))).toBe(true);
      expect(existsSync(join(worktreePath, 'public.ts'))).toBe(true);
      expect(existsSync(join(worktreePath, 'secret.ts'))).toBe(true);
      expect(existsSync(join(worktreePath, 'src', 'index.ts'))).toBe(true);
      expect(existsSync(join(worktreePath, 'internal', 'config.ts'))).toBe(
        true
      );
    });

    it('should handle patterns with leading slashes', () => {
      // Setup sparse checkout with leading slash pattern
      git.setupSparseCheckout(worktreePath, ['/secret.ts']);

      // Check that secret.ts is not in the worktree
      expect(existsSync(join(worktreePath, 'secret.ts'))).toBe(false);

      // Check that other files still exist
      expect(existsSync(join(worktreePath, 'README.md'))).toBe(true);
    });
  });

  describe('checkoutBranch', () => {
    it('creates a missing local branch from the remote task branch when available', () => {
      const remoteDir = join(
        tmpdir(),
        `git-remote-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const cloneDir = join(
        tmpdir(),
        `git-clone-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );

      mkdirSync(remoteDir, { recursive: true });

      try {
        launchSync('git', ['init', '--bare', remoteDir]);
        launchSync('git', ['remote', 'add', 'origin', remoteDir], {
          cwd: testDir,
        });

        writeFileSync(join(testDir, 'README.md'), '# Test');
        launchSync('git', ['add', '.'], { cwd: testDir });
        launchSync('git', ['commit', '-m', 'Initial commit'], { cwd: testDir });
        launchSync('git', ['branch', '-M', 'main'], { cwd: testDir });
        launchSync('git', ['push', '-u', 'origin', 'main'], { cwd: testDir });

        launchSync('git', ['checkout', '-b', 'task/test-branch'], {
          cwd: testDir,
        });
        writeFileSync(join(testDir, 'task.txt'), 'remote task branch commit\n');
        launchSync('git', ['add', '.'], { cwd: testDir });
        launchSync('git', ['commit', '-m', 'Task branch commit'], {
          cwd: testDir,
        });
        const remoteTaskCommit = launchSync('git', ['rev-parse', 'HEAD'], {
          cwd: testDir,
        })
          .stdout?.toString()
          .trim();
        launchSync('git', ['push', '-u', 'origin', 'task/test-branch'], {
          cwd: testDir,
        });

        launchSync('git', ['checkout', 'main'], { cwd: testDir });

        launchSync('git', ['clone', remoteDir, cloneDir]);
        launchSync('git', ['config', 'user.email', 'test@example.com'], {
          cwd: cloneDir,
        });
        launchSync('git', ['config', 'user.name', 'Test User'], {
          cwd: cloneDir,
        });
        launchSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: cloneDir,
        });

        const clonedGit = new Git({ cwd: cloneDir });
        expect(clonedGit.branchExists('task/test-branch')).toBe(false);
        expect(clonedGit.remoteBranchExists('task/test-branch')).toBe(true);

        clonedGit.checkoutBranch('task/test-branch', { createIfMissing: true });

        expect(clonedGit.getCurrentBranch()).toBe('task/test-branch');
        expect(clonedGit.getCommitHash('HEAD')).toBe(remoteTaskCommit);
      } finally {
        rmSync(cloneDir, { recursive: true, force: true });
        rmSync(remoteDir, { recursive: true, force: true });
      }
    });

    it('fetches a task branch before creating it locally when remote refs are stale', () => {
      const remoteDir = join(
        tmpdir(),
        `git-remote-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const sourceDir = join(
        tmpdir(),
        `git-source-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const cloneDir = join(
        tmpdir(),
        `git-clone-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );

      mkdirSync(remoteDir, { recursive: true });
      mkdirSync(sourceDir, { recursive: true });

      try {
        launchSync('git', ['init', '--bare', remoteDir]);

        launchSync('git', ['init'], { cwd: sourceDir });
        launchSync('git', ['config', 'user.email', 'test@example.com'], {
          cwd: sourceDir,
        });
        launchSync('git', ['config', 'user.name', 'Test User'], {
          cwd: sourceDir,
        });
        launchSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: sourceDir,
        });
        launchSync('git', ['remote', 'add', 'origin', remoteDir], {
          cwd: sourceDir,
        });

        writeFileSync(join(sourceDir, 'README.md'), '# Test');
        launchSync('git', ['add', '.'], { cwd: sourceDir });
        launchSync('git', ['commit', '-m', 'Initial commit'], {
          cwd: sourceDir,
        });
        launchSync('git', ['branch', '-M', 'main'], { cwd: sourceDir });
        launchSync('git', ['push', '-u', 'origin', 'main'], { cwd: sourceDir });

        launchSync('git', ['clone', remoteDir, cloneDir]);
        launchSync('git', ['config', 'user.email', 'test@example.com'], {
          cwd: cloneDir,
        });
        launchSync('git', ['config', 'user.name', 'Test User'], {
          cwd: cloneDir,
        });
        launchSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: cloneDir,
        });

        launchSync('git', ['checkout', '-b', 'task/test-branch'], {
          cwd: sourceDir,
        });
        writeFileSync(
          join(sourceDir, 'task.txt'),
          'remote task branch commit\n'
        );
        launchSync('git', ['add', '.'], { cwd: sourceDir });
        launchSync('git', ['commit', '-m', 'Task branch commit'], {
          cwd: sourceDir,
        });
        const remoteTaskCommit = launchSync('git', ['rev-parse', 'HEAD'], {
          cwd: sourceDir,
        })
          .stdout?.toString()
          .trim();
        launchSync('git', ['push', '-u', 'origin', 'task/test-branch'], {
          cwd: sourceDir,
        });

        const clonedGit = new Git({ cwd: cloneDir });
        expect(clonedGit.branchExists('task/test-branch')).toBe(false);
        expect(clonedGit.remoteBranchExists('task/test-branch')).toBe(false);

        clonedGit.checkoutBranch('task/test-branch', { createIfMissing: true });

        expect(clonedGit.getCurrentBranch()).toBe('task/test-branch');
        expect(clonedGit.getCommitHash('HEAD')).toBe(remoteTaskCommit);
        expect(clonedGit.remoteBranchExists('task/test-branch')).toBe(true);
      } finally {
        rmSync(cloneDir, { recursive: true, force: true });
        rmSync(sourceDir, { recursive: true, force: true });
        rmSync(remoteDir, { recursive: true, force: true });
      }
    });

    it('does not create a local task branch from HEAD when fetching the remote branch fails unexpectedly', () => {
      const cloneDir = join(
        tmpdir(),
        `git-clone-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );

      mkdirSync(cloneDir, { recursive: true });

      try {
        launchSync('git', ['init'], { cwd: cloneDir });
        launchSync('git', ['config', 'user.email', 'test@example.com'], {
          cwd: cloneDir,
        });
        launchSync('git', ['config', 'user.name', 'Test User'], {
          cwd: cloneDir,
        });
        launchSync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: cloneDir,
        });

        writeFileSync(join(cloneDir, 'README.md'), '# Test');
        launchSync('git', ['add', '.'], { cwd: cloneDir });
        launchSync('git', ['commit', '-m', 'Initial commit'], {
          cwd: cloneDir,
        });

        launchSync(
          'git',
          ['remote', 'add', 'origin', 'https://127.0.0.1:1/repo.git'],
          {
            cwd: cloneDir,
          }
        );

        const clonedGit = new Git({ cwd: cloneDir });

        expect(() =>
          clonedGit.checkoutBranch('task/test-branch', {
            createIfMissing: true,
          })
        ).toThrow(/Failed to fetch remote branch 'origin\/task\/test-branch'/);
        expect(clonedGit.branchExists('task/test-branch')).toBe(false);
      } finally {
        rmSync(cloneDir, { recursive: true, force: true });
      }
    });
  });
});
