import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodexRateWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number; // unix timestamp
}

export interface CodexRateLimit {
  allowed: boolean;
  limit_reached: boolean;
  primary_window: CodexRateWindow;
  secondary_window: CodexRateWindow | null;
}

export interface CodexAdditionalRateLimit {
  limit_name: string;
  metered_feature: string;
  rate_limit: CodexRateLimit;
}

export interface CodexUsageRaw {
  user_id: string;
  account_id: string;
  email: string;
  plan_type: string;
  rate_limit: CodexRateLimit;
  code_review_rate_limit: CodexRateLimit;
  additional_rate_limits: CodexAdditionalRateLimit[];
  credits: {
    has_credits: boolean;
    unlimited: boolean;
    balance: string;
  };
}

/** Normalized bucket matching the Claude format for consistency. */
export interface NormalizedBucket {
  utilization: number; // 0-100
  resets_at: string; // ISO 8601
}

export interface CodexUsageResponse {
  plan_type: string;
  five_hour: NormalizedBucket | null;
  seven_day: NormalizedBucket | null;
  models: Record<
    string,
    {
      five_hour: NormalizedBucket | null;
      seven_day: NormalizedBucket | null;
    }
  >;
}

// ---------------------------------------------------------------------------
// Credential reading
// ---------------------------------------------------------------------------

export interface CodexAuth {
  access_token: string;
  account_id: string;
}

/**
 * Read Codex OAuth tokens from `~/.codex/auth.json`.
 * Returns `null` if unavailable.
 */
export function readCodexAuth(): CodexAuth | null {
  try {
    const authPath = join(homedir(), '.codex', 'auth.json');
    const raw = readFileSync(authPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const tokens = parsed?.tokens;
    if (!tokens?.access_token || !tokens?.account_id) return null;
    return {
      access_token: tokens.access_token,
      account_id: tokens.account_id,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cached API call
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 10_000;

let cachedResponse: CodexUsageResponse | null = null;
let cacheTimestamp = 0;

export function invalidateCodexUsageCache(): void {
  cachedResponse = null;
  cacheTimestamp = 0;
}

function normalizeWindow(
  w: CodexRateWindow | null | undefined
): NormalizedBucket | null {
  if (!w) return null;
  return {
    utilization: w.used_percent,
    resets_at: new Date(w.reset_at * 1000).toISOString(),
  };
}

/**
 * Fetch usage data from the Codex/ChatGPT backend API.
 * Results are cached for 5 minutes. Returns `null` on any failure.
 */
export async function fetchCodexUsage(): Promise<CodexUsageResponse | null> {
  if (cachedResponse && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedResponse;
  }

  const auth = readCodexAuth();
  if (!auth) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        Authorization: `Bearer ${auth.access_token}`,
        'chatgpt-account-id': auth.account_id,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const raw = (await response.json()) as CodexUsageRaw;

    // Normalize to consistent format
    const result: CodexUsageResponse = {
      plan_type: raw.plan_type || 'unknown',
      five_hour: normalizeWindow(raw.rate_limit?.primary_window),
      seven_day: normalizeWindow(raw.rate_limit?.secondary_window),
      models: {},
    };

    // Per-model limits
    for (const extra of raw.additional_rate_limits || []) {
      const slug = extra.limit_name || extra.metered_feature;
      if (!slug) continue;
      result.models[slug] = {
        five_hour: normalizeWindow(extra.rate_limit?.primary_window),
        seven_day: normalizeWindow(extra.rate_limit?.secondary_window),
      };
    }

    cachedResponse = result;
    cacheTimestamp = Date.now();
    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Usage analysis
// ---------------------------------------------------------------------------

export interface CodexUsageCheckResult {
  isExhausted: boolean;
  resetsAt: Date | null;
  utilization: number;
  limitingBucket: string | null;
}

// Pipeline handles usage gating at configurable thresholds (default 10% reserve).
// Rover only self-pauses as a last-resort safety net at 1% remaining.
const EXHAUSTION_THRESHOLD = 99; // 0-100 scale

/**
 * Analyze codex usage to determine whether any bucket is exhausted.
 *
 * When `model` is provided, also checks per-model limits.
 * The threshold is 90% utilization (keeping 10% buffer).
 */
export function analyzeCodexUsage(
  usage: CodexUsageResponse,
  model?: string
): CodexUsageCheckResult {
  let highestUtil = 0;
  let earliestReset: Date | null = null;
  let limitingBucket: string | null = null;
  let isExhausted = false;

  const checkBucket = (bucket: NormalizedBucket | null, name: string) => {
    if (!bucket) return;
    if (bucket.utilization > highestUtil) {
      highestUtil = bucket.utilization;
    }
    if (bucket.utilization >= EXHAUSTION_THRESHOLD) {
      isExhausted = true;
      const resetDate = new Date(bucket.resets_at);
      if (!earliestReset || resetDate.getTime() < earliestReset.getTime()) {
        earliestReset = resetDate;
        limitingBucket = name;
      }
    }
  };

  // Global limits
  checkBucket(usage.five_hour, 'five_hour');
  checkBucket(usage.seven_day, 'seven_day');

  // Per-model limits
  if (model) {
    const modelLower = model.toLowerCase();
    for (const [slug, limits] of Object.entries(usage.models)) {
      if (
        slug.toLowerCase().includes(modelLower) ||
        modelLower.includes(slug.toLowerCase())
      ) {
        checkBucket(limits.five_hour, `${slug}/five_hour`);
        checkBucket(limits.seven_day, `${slug}/seven_day`);
      }
    }
  }

  return {
    isExhausted,
    resetsAt: earliestReset,
    utilization: highestUtil,
    limitingBucket,
  };
}

/**
 * Fetch codex usage and analyze it in one call.
 * Returns `null` if credentials are unavailable or the API call fails.
 */
export async function checkCodexUsage(
  model?: string
): Promise<CodexUsageCheckResult | null> {
  try {
    const usage = await fetchCodexUsage();
    if (!usage) return null;
    return analyzeCodexUsage(usage, model);
  } catch {
    return null;
  }
}
