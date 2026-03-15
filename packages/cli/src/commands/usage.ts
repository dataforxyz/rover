import colors from 'ansi-colors';
import {
  fetchClaudeUsage,
  readClaudeOAuthToken,
  type ClaudeUsageResponse,
  type ExtraUsageBucket,
  type UsageBucket,
} from '../lib/claude-usage.js';
import {
  fetchCodexUsage,
  readCodexAuth,
  type CodexUsageResponse,
  type NormalizedBucket,
} from '../lib/codex-usage.js';
import { isJsonMode } from '../lib/context.js';
import type { CommandDefinition } from '../types.js';

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

const CLAUDE_BUCKET_LABELS: Record<string, string> = {
  five_hour: '5-Hour',
  seven_day: '7-Day',
  seven_day_sonnet: '7-Day Sonnet',
  seven_day_opus: '7-Day Opus',
  seven_day_oauth_apps: '7-Day OAuth',
  seven_day_cowork: '7-Day Cowork',
  iguana_necktie: 'Iguana Necktie',
};

interface BucketInfo {
  label: string;
  pct: number;
  status: string;
  resetStr: string;
  resetAt: string;
  colorFn: (s: string) => string;
}

function formatBucket(
  label: string,
  utilization: number,
  resets_at: string
): BucketInfo {
  const pct = Math.round(utilization);
  const resetDate = new Date(resets_at);
  const now = new Date();
  const diffMs = resetDate.getTime() - now.getTime();
  const diffMins = Math.max(0, Math.round(diffMs / 60000));

  let status: string;
  let colorFn: (s: string) => string;
  if (pct >= 95) {
    status = 'EXHAUSTED';
    colorFn = colors.red;
  } else if (pct >= 80) {
    status = 'HIGH';
    colorFn = colors.yellow;
  } else {
    status = 'OK';
    colorFn = colors.green;
  }

  const resetStr =
    diffMins > 60
      ? `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`
      : `${diffMins}m`;

  return { label, pct, status, resetStr, resetAt: resets_at, colorFn };
}

function formatClaudeBucket(
  name: string,
  bucket: UsageBucket | null | undefined
): BucketInfo | null {
  if (!bucket) return null;
  const label = CLAUDE_BUCKET_LABELS[name] || name;
  return formatBucket(label, bucket.utilization, bucket.resets_at);
}

function formatNormalizedBucket(
  label: string,
  bucket: NormalizedBucket | null | undefined
): BucketInfo | null {
  if (!bucket) return null;
  return formatBucket(label, bucket.utilization, bucket.resets_at);
}

function printBucketLine(info: BucketInfo) {
  const line = `${info.label.padEnd(20)} ${`${info.pct}%`.padEnd(8)} ${info.colorFn(info.status.padEnd(12))} ${info.resetStr}`;
  console.log(`  ${line}`);
}

function printHeader() {
  console.log(
    colors.gray(
      `${'Bucket'.padEnd(20)} ${'Usage'.padEnd(8)} ${'Status'.padEnd(12)} Reset In`
    )
  );
  console.log(colors.gray('─'.repeat(60)));
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

const usageCommand = async (_options: { json?: boolean } = {}) => {
  const hasClaude = !!readClaudeOAuthToken();
  const hasCodex = !!readCodexAuth();

  if (!hasClaude && !hasCodex) {
    if (isJsonMode()) {
      console.log(
        JSON.stringify({
          success: false,
          error: 'No credentials found for Claude or Codex',
        })
      );
    } else {
      console.log(colors.yellow('\nNo credentials found for Claude or Codex.'));
    }
    process.exit(1);
  }

  // Fetch both in parallel
  const [claudeUsage, codexUsage] = await Promise.all([
    hasClaude ? fetchClaudeUsage() : Promise.resolve(null),
    hasCodex ? fetchCodexUsage() : Promise.resolve(null),
  ]);

  // --- JSON mode ---
  if (isJsonMode()) {
    const output: Record<string, unknown> = { success: true };

    // Claude: flat fields for backward compat + nested
    if (claudeUsage) {
      // Flat (backward compat)
      for (const [key, val] of Object.entries(claudeUsage)) {
        output[key] = val;
      }
      // Nested
      output.claude = { ...claudeUsage };
    }

    // Codex: nested only
    if (codexUsage) {
      output.codex = codexUsage;
    }

    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // --- Human-readable mode ---

  // Claude section
  if (hasClaude) {
    console.log(colors.cyan('\nClaude Usage'));
    console.log(colors.gray('─'.repeat(60)));

    if (!claudeUsage) {
      console.log(colors.red('  Failed to fetch usage data from Claude API.'));
    } else {
      printHeader();

      const claudeBucketNames: (keyof ClaudeUsageResponse)[] = [
        'five_hour',
        'seven_day',
        'seven_day_sonnet',
        'seven_day_opus',
        'seven_day_oauth_apps',
        'seven_day_cowork',
        'iguana_necktie',
      ];

      for (const name of claudeBucketNames) {
        if (name === 'extra_usage') continue;
        const info = formatClaudeBucket(
          name,
          claudeUsage[name] as UsageBucket | null | undefined
        );
        if (!info) continue;
        printBucketLine(info);
      }

      // Extra usage
      if (claudeUsage.extra_usage) {
        const extra = claudeUsage.extra_usage;
        console.log();
        console.log(colors.gray('─'.repeat(60)));
        console.log(colors.cyan('  Extra Usage'));
        console.log(
          `  Enabled:       ${extra.is_enabled ? colors.green('Yes') : colors.gray('No')}`
        );
        if (extra.is_enabled) {
          const limit =
            extra.monthly_limit != null ? `$${extra.monthly_limit}` : 'N/A';
          const used =
            extra.used_credits != null ? `$${extra.used_credits}` : 'N/A';
          const util =
            extra.utilization != null
              ? `${Math.round(extra.utilization)}%`
              : 'N/A';
          console.log(`  Monthly Limit: ${limit}`);
          console.log(`  Used:          ${used}`);
          console.log(`  Utilization:   ${util}`);
        }
      }
    }
  }

  // Codex section
  if (hasCodex) {
    console.log(colors.cyan('\nCodex Usage'));
    console.log(colors.gray('─'.repeat(60)));

    if (!codexUsage) {
      console.log(colors.red('  Failed to fetch usage data from Codex API.'));
    } else {
      console.log(colors.gray(`  Plan: ${codexUsage.plan_type}`));
      console.log();
      printHeader();

      // Global codex limits
      const fiveHour = formatNormalizedBucket('5-Hour', codexUsage.five_hour);
      if (fiveHour) printBucketLine(fiveHour);
      const sevenDay = formatNormalizedBucket('7-Day', codexUsage.seven_day);
      if (sevenDay) printBucketLine(sevenDay);

      // Per-model limits
      for (const [model, limits] of Object.entries(codexUsage.models)) {
        console.log();
        console.log(colors.gray(`  Model: ${model}`));
        const mFive = formatNormalizedBucket(`  5-Hour`, limits.five_hour);
        if (mFive) printBucketLine(mFive);
        const mSeven = formatNormalizedBucket(`  7-Day`, limits.seven_day);
        if (mSeven) printBucketLine(mSeven);
      }
    }
  }

  console.log();
};

export { usageCommand };

export default {
  name: 'usage',
  description: 'Show Claude and Codex API usage and rate limit status',
  requireProject: false,
  action: usageCommand,
} satisfies CommandDefinition;
