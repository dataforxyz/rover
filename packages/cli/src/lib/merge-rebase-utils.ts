/**
 * Shared utilities for merge and rebase commands.
 * Consolidates duplicated logic like iteration summaries, commit message
 * generation, and AI-powered conflict resolution.
 */
import colors from 'ansi-colors';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import yoctoSpinner from 'yocto-spinner';
import type { AIAgentTool } from './agents/index.js';
import { type Git } from 'rover-core';
import { resolvePathWithinRoot } from '../utils/path-safety.js';
import { isJsonMode } from './context.js';
import {
  truncateConflictContext,
  getBlameContext,
  parseResolvedRegions,
  reconstructFile,
  sanitizeAIOutput,
  hasConflictMarkers,
} from './context-optimizer.js';

/**
 * Get summaries from all iterations of a task.
 */
export const getTaskIterationSummaries = (iterationsPath: string): string[] => {
  try {
    if (!existsSync(iterationsPath)) {
      return [];
    }

    const iterations = readdirSync(iterationsPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => parseInt(dirent.name, 10))
      .filter(num => !Number.isNaN(num))
      .sort((a, b) => a - b);

    const summaries: string[] = [];

    for (const iteration of iterations) {
      const iterationPath = join(iterationsPath, iteration.toString());
      const summaryPath = join(iterationPath, 'summary.md');

      if (existsSync(summaryPath)) {
        try {
          const summary = readFileSync(summaryPath, 'utf8').trim();
          if (summary) {
            summaries.push(`Iteration ${iteration}: ${summary}`);
          }
        } catch {
          if (!isJsonMode()) {
            console.warn(
              colors.yellow(
                `Warning: Could not read summary for iteration ${iteration}`
              )
            );
          }
        }
      }
    }

    return summaries;
  } catch {
    if (!isJsonMode()) {
      console.warn(
        colors.yellow('Warning: Could not retrieve iteration summaries')
      );
    }
    return [];
  }
};

/**
 * Generate AI-powered commit message using iteration summaries.
 */
export const generateCommitMessage = async (
  taskTitle: string,
  taskDescription: string,
  recentCommits: string[],
  summaries: string[],
  aiAgent: AIAgentTool
): Promise<string | null> => {
  try {
    const commitMessage = await aiAgent.generateCommitMessage(
      taskTitle,
      taskDescription,
      recentCommits,
      summaries
    );

    if (commitMessage == null || commitMessage.length === 0) {
      if (!isJsonMode()) {
        console.warn(
          colors.yellow('Warning: Could not generate AI commit message')
        );
      }
    }

    return commitMessage;
  } catch {
    if (!isJsonMode()) {
      console.warn(
        colors.yellow('Warning: Could not generate AI commit message')
      );
    }
    return null;
  }
};

/**
 * Options for AI conflict resolution.
 */
export interface ResolveConflictsOptions {
  /** Git instance for the repository */
  git: Git;
  /** List of file paths with conflicts */
  conflictedFiles: string[];
  /** AI agent tool for resolution */
  aiAgent: AIAgentTool;
  /** Root path to resolve files within (git root or worktree path) */
  rootPath: string;
  /** "theirs" ref for blame context (e.g. MERGE_HEAD, REBASE_HEAD) */
  theirsRef: string;
  /** Optional worktree path (for rebase operations) */
  worktreePath?: string;
  /** Max concurrent AI resolution calls */
  concurrency?: number;
  /** Number of context lines for truncated conflict view */
  contextLines?: number;
  /** Send entire file to AI instead of just conflict regions */
  sendFullFile?: boolean;
}

/**
 * Unified AI-powered conflict resolver for both merge and rebase operations.
 * Resolves files concurrently but stages them sequentially to avoid git index contention.
 */
export const resolveConflicts = async (
  opts: ResolveConflictsOptions
): Promise<{ success: boolean; failureReason?: string }> => {
  const {
    git,
    conflictedFiles,
    aiAgent,
    rootPath,
    theirsRef,
    worktreePath,
    concurrency = 4,
    contextLines = 50,
    sendFullFile = false,
  } = opts;

  let spinner;

  if (!isJsonMode()) {
    spinner = yoctoSpinner({
      text: `Resolving conflicts in ${conflictedFiles.length} file(s)...`,
    }).start();
  }

  try {
    const branchName = git.getCurrentBranch(
      worktreePath ? { worktreePath } : undefined
    );
    const fallbackDiffContext = sendFullFile
      ? git
          .getRecentCommits({
            branch: branchName === 'unknown' ? 'HEAD' : branchName,
            ...(worktreePath ? { worktreePath } : {}),
          })
          .join('\n')
      : '';

    const failures: string[] = [];
    let resolvedCount = 0;
    const executing = new Set<Promise<void>>();
    // Collect resolved content in memory — only write to disk if ALL files resolve
    const resolvedResults: {
      filePath: string;
      fullPath: string;
      content: string;
    }[] = [];

    const gitRoot =
      rootPath || worktreePath || resolve(git.getRepositoryRoot() || '.');

    for (const filePath of conflictedFiles) {
      const task = (async () => {
        const fullPath = resolvePathWithinRoot(gitRoot, filePath);
        if (!fullPath) {
          failures.push(`Path traversal rejected: ${filePath}`);
          return;
        }

        if (!existsSync(fullPath)) {
          failures.push(`File ${filePath} not found`);
          return;
        }

        const rawContent = readFileSync(fullPath, 'utf8');

        let conflictedContent: string;
        let diffContext: string;
        const truncated = sendFullFile
          ? null
          : truncateConflictContext(rawContent, contextLines);

        if (sendFullFile || !truncated) {
          conflictedContent = rawContent;
          diffContext = fallbackDiffContext;
        } else {
          conflictedContent = truncated.content;
          diffContext = getBlameContext(
            git,
            filePath,
            truncated.conflictRegions,
            { ours: 'HEAD', theirs: theirsRef },
            worktreePath
          );
          if (!diffContext) {
            diffContext =
              fallbackDiffContext ||
              git
                .getRecentCommits({
                  branch: branchName === 'unknown' ? 'HEAD' : branchName,
                  ...(worktreePath ? { worktreePath } : {}),
                })
                .join('\n');
          }
        }

        try {
          let finalContent: string | null = null;

          if (sendFullFile || !truncated) {
            finalContent = await aiAgent.resolveMergeConflicts(
              filePath,
              diffContext,
              conflictedContent
            );
            if (finalContent) {
              finalContent = sanitizeAIOutput(finalContent, rawContent);
            }
          } else {
            const regionCount = truncated.conflictRegions.length;

            try {
              let regionOutput = await aiAgent.resolveMergeConflictsRegions(
                filePath,
                diffContext,
                conflictedContent,
                regionCount
              );

              if (regionOutput) {
                regionOutput = sanitizeAIOutput(
                  regionOutput,
                  conflictedContent
                );
                const resolvedRegions = parseResolvedRegions(
                  regionOutput,
                  regionCount
                );
                finalContent = reconstructFile(
                  rawContent,
                  truncated.conflictRegions,
                  resolvedRegions
                );
              }
            } catch {
              finalContent = await aiAgent.resolveMergeConflicts(
                filePath,
                diffContext,
                rawContent
              );
              if (finalContent) {
                finalContent = sanitizeAIOutput(finalContent, rawContent);
              }
            }
          }

          if (!finalContent) {
            failures.push(`AI returned empty resolution for ${filePath}`);
            return;
          }

          if (hasConflictMarkers(finalContent)) {
            failures.push(
              `AI output for ${filePath} still contains conflict markers`
            );
            return;
          }

          resolvedResults.push({ filePath, fullPath, content: finalContent });

          resolvedCount++;
          if (spinner) {
            spinner.text = `Resolved ${resolvedCount}/${conflictedFiles.length} file(s)...`;
          }
        } catch (error) {
          failures.push(`Error resolving ${filePath}: ${error}`);
        }
      })();

      const wrapped = task.finally(() => {
        executing.delete(wrapped);
      });
      executing.add(wrapped);

      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }

    await Promise.all(executing);

    // Only write resolved files to disk if ALL files were resolved successfully.
    // This prevents leaving the working tree in a partially-resolved state.
    if (failures.length > 0) {
      const reason = failures.join('; ');
      spinner?.error(`Failed to resolve ${failures.length} file(s)`);
      return { success: false, failureReason: reason };
    }

    // All resolutions succeeded — atomically write and stage each file
    for (const { filePath, fullPath, content } of resolvedResults) {
      const tmpPath = fullPath + '.tmp.' + process.pid;
      try {
        writeFileSync(tmpPath, content);
        renameSync(tmpPath, fullPath);
      } catch (writeErr) {
        rmSync(tmpPath, { force: true });
        spinner?.error(`Failed to write resolved file: ${filePath}`);
        return {
          success: false,
          failureReason: `Error writing ${filePath}: ${writeErr}`,
        };
      }

      const added = worktreePath
        ? git.add(filePath, { worktreePath })
        : git.add(filePath);
      if (!added) {
        failures.push(`Error adding ${filePath} to the git commit`);
      }
    }

    if (failures.length > 0) {
      const reason = failures.join('; ');
      spinner?.error(`Failed to resolve ${failures.length} file(s)`);
      return { success: false, failureReason: reason };
    }

    spinner?.success('All conflicts resolved by AI');
    return { success: true };
  } catch (error) {
    const reason = `Failed to resolve conflicts: ${error}`;
    spinner?.error(reason);
    return { success: false, failureReason: reason };
  }
};
