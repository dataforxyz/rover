import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { platform } from 'node:process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageBucket {
  limit: number;
  remaining: number;
  utilization: number;
  resets_at: string;
  expires_at: string;
}

export interface ExtraUsageBucket {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
}

export interface ClaudeUsageResponse {
  five_hour?: UsageBucket | null;
  seven_day?: UsageBucket | null;
  seven_day_sonnet?: UsageBucket | null;
  seven_day_opus?: UsageBucket | null;
  seven_day_oauth_apps?: UsageBucket | null;
  seven_day_cowork?: UsageBucket | null;
  iguana_necktie?: UsageBucket | null;
  extra_usage?: ExtraUsageBucket | null;
}

export interface UsageCheckResult {
  isExhausted: boolean;
  resetsAt: Date | null;
  utilization: number;
  limitingBucket: string | null;
}

// ---------------------------------------------------------------------------
// Credential reading
// ---------------------------------------------------------------------------

/**
 * Read the Claude OAuth access token from `~/.claude/.credentials.json`.
 * Falls back to macOS Keychain on darwin. Returns `null` if unavailable.
 */
export function readClaudeOAuthToken(): string | null {
  // Try disk credential file first
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    const raw = readFileSync(credPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const token = parsed?.claudeAiOauth?.accessToken;
    if (typeof token === 'string' && token.length > 0) {
      return token;
    }
  } catch {
    // File missing or malformed — continue to fallback
  }

  // macOS Keychain fallback
  if (platform === 'darwin') {
    try {
      // Lazy import to avoid pulling in rover-core at module level for
      // non-macOS platforms and to keep the module testable in isolation.
      const { findKeychainCredentials } = require('../lib/agents/index.js');
      const raw = findKeychainCredentials('Claude Code-credentials');
      if (raw) {
        const parsed = JSON.parse(raw);
        const token = parsed?.claudeAiOauth?.accessToken;
        if (typeof token === 'string' && token.length > 0) {
          return token;
        }
      }
    } catch {
      // Keychain unavailable or parse error
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Cached API call
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 10_000; // 10 seconds

let cachedResponse: ClaudeUsageResponse | null = null;
let cacheTimestamp = 0;

/** Force the next `fetchClaudeUsage()` call to hit the API. */
export function invalidateUsageCache(): void {
  cachedResponse = null;
  cacheTimestamp = 0;
}

/**
 * Fetch usage data from the Claude OAuth usage endpoint.
 * Results are cached for 5 minutes. Returns `null` on any failure.
 */
export async function fetchClaudeUsage(): Promise<ClaudeUsageResponse | null> {
  // Return cached data if still fresh
  if (cachedResponse && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedResponse;
  }

  const token = readClaudeOAuthToken();
  if (!token) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = (await response.json()) as ClaudeUsageResponse;
    cachedResponse = data;
    cacheTimestamp = Date.now();
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model family resolution
// ---------------------------------------------------------------------------

export type ClaudeModelFamily = 'opus' | 'sonnet' | 'haiku';

/**
 * Resolve a model string to a Claude model family.
 * Returns `null` if the model is unrecognized or undefined.
 */
export function resolveClaudeModelFamily(
  model?: string
): ClaudeModelFamily | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return null;
}

/**
 * Return the usage buckets relevant to a given model family.
 * When the family is `null` (unknown), all 4 buckets are checked (conservative).
 */
export function getRelevantBuckets(
  family: ClaudeModelFamily | null
): (keyof ClaudeUsageResponse)[] {
  switch (family) {
    case 'opus':
      return ['five_hour', 'seven_day', 'seven_day_opus'];
    case 'sonnet':
      return ['five_hour', 'seven_day', 'seven_day_sonnet'];
    case 'haiku':
      return ['five_hour', 'seven_day'];
    default:
      return ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus'];
  }
}

// ---------------------------------------------------------------------------
// Usage analysis
// ---------------------------------------------------------------------------

// Pipeline handles usage gating at configurable thresholds (default 10% reserve).
// Rover only self-pauses as a last-resort safety net at 1% remaining.
const EXHAUSTION_THRESHOLD = 0.99;

const ALL_BUCKET_NAMES: (keyof ClaudeUsageResponse)[] = [
  'five_hour',
  'seven_day',
  'seven_day_sonnet',
  'seven_day_opus',
];

/**
 * Analyze a usage response to determine whether any bucket is exhausted
 * and when the earliest reset occurs among exhausted buckets.
 *
 * When `model` is provided, only buckets relevant to that model family
 * are checked. When omitted, all 4 buckets are checked (conservative).
 */
export function analyzeUsage(
  usage: ClaudeUsageResponse,
  model?: string
): UsageCheckResult {
  const family = resolveClaudeModelFamily(model);
  const bucketNames = getRelevantBuckets(family);

  let isExhausted = false;
  let earliestReset: Date | null = null;
  let highestUtilization = 0;
  let limitingBucket: string | null = null;

  for (const name of bucketNames) {
    const bucket = usage[name];
    if (!bucket) continue;

    const util = bucket.utilization;
    if (util > highestUtilization) {
      highestUtilization = util;
    }

    if (util >= EXHAUSTION_THRESHOLD) {
      isExhausted = true;
      const resetDate = new Date(bucket.resets_at);
      if (!earliestReset || resetDate.getTime() < earliestReset.getTime()) {
        earliestReset = resetDate;
        limitingBucket = name;
      }
    }
  }

  return {
    isExhausted,
    resetsAt: earliestReset,
    utilization: highestUtilization,
    limitingBucket,
  };
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

/**
 * Fetch usage data and analyze it in one call.
 * Returns `null` if credentials are unavailable or the API call fails.
 *
 * When `model` is provided, only buckets relevant to that model family
 * are checked. When omitted, all 4 buckets are checked (conservative).
 */
export async function checkClaudeUsage(
  model?: string
): Promise<UsageCheckResult | null> {
  try {
    const usage = await fetchClaudeUsage();
    if (!usage) return null;
    return analyzeUsage(usage, model);
  } catch {
    return null;
  }
}
