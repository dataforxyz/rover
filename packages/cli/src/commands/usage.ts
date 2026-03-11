import colors from 'ansi-colors';
import {
  fetchClaudeUsage,
  readClaudeOAuthToken,
  type ClaudeUsageResponse,
  type UsageBucket,
} from '../lib/claude-usage.js';
import { isJsonMode } from '../lib/context.js';
import type { CommandDefinition } from '../types.js';

const BUCKET_LABELS: Record<string, string> = {
  five_hour: '5-Hour',
  seven_day: '7-Day',
  seven_day_sonnet: '7-Day Sonnet',
  seven_day_opus: '7-Day Opus',
};

function formatBucket(name: string, bucket: UsageBucket | null | undefined) {
  if (!bucket) return null;

  const pct = Math.round(bucket.utilization * 100);
  const resetDate = new Date(bucket.resets_at);
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

  const label = BUCKET_LABELS[name] || name;
  const resetStr =
    diffMins > 60
      ? `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`
      : `${diffMins}m`;

  return {
    label,
    pct,
    status,
    resetStr,
    resetAt: bucket.resets_at,
    colorFn,
  };
}

const usageCommand = async (_options: { json?: boolean } = {}) => {
  const token = readClaudeOAuthToken();
  if (!token) {
    if (isJsonMode()) {
      console.log(
        JSON.stringify({ success: false, error: 'No Claude credentials found' })
      );
    } else {
      console.log(
        colors.yellow(
          '\nNo Claude credentials found. Ensure ~/.claude/.credentials.json exists with a valid OAuth token.'
        )
      );
    }
    process.exit(1);
  }

  const usage = await fetchClaudeUsage();
  if (!usage) {
    if (isJsonMode()) {
      console.log(
        JSON.stringify({
          success: false,
          error: 'Failed to fetch usage data from Claude API',
        })
      );
    } else {
      console.log(colors.red('\nFailed to fetch usage data from Claude API.'));
    }
    process.exit(1);
  }

  if (isJsonMode()) {
    console.log(JSON.stringify({ success: true, ...usage }, null, 2));
    return;
  }

  console.log(colors.cyan('\nClaude Usage'));
  console.log(colors.gray('─'.repeat(55)));
  console.log(
    colors.gray(
      `${'Bucket'.padEnd(16)} ${'Usage'.padEnd(8)} ${'Status'.padEnd(12)} Reset In`
    )
  );
  console.log(colors.gray('─'.repeat(55)));

  const bucketNames: (keyof ClaudeUsageResponse)[] = [
    'five_hour',
    'seven_day',
    'seven_day_sonnet',
    'seven_day_opus',
  ];

  for (const name of bucketNames) {
    const info = formatBucket(name, usage[name]);
    if (!info) continue;

    const line = `${info.label.padEnd(16)} ${`${info.pct}%`.padEnd(8)} ${info.colorFn(info.status.padEnd(12))} ${info.resetStr}`;
    console.log(`  ${line}`);
  }

  console.log();
};

export { usageCommand };

export default {
  name: 'usage',
  description: 'Show Claude API usage and rate limit status',
  requireProject: false,
  action: usageCommand,
} satisfies CommandDefinition;
