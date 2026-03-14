import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
}));

import { readFileSync } from 'node:fs';
import {
  readCodexAuth,
  fetchCodexUsage,
  invalidateCodexUsageCache,
  analyzeCodexUsage,
  checkCodexUsage,
  type CodexUsageResponse,
} from '../codex-usage.js';

const mockedReadFileSync = vi.mocked(readFileSync);
const mockFetch = vi.fn();

const CODEX_AUTH = {
  auth_mode: 'chatgpt',
  tokens: {
    access_token: 'test-codex-token',
    refresh_token: 'refresh-token',
    id_token: 'id-token',
    account_id: 'test-account-id',
  },
};

const CODEX_USAGE_RAW = {
  user_id: 'user-test',
  account_id: 'user-test',
  email: 'test@test.com',
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 10,
      limit_window_seconds: 18000,
      reset_after_seconds: 17000,
      reset_at: 1773280459,
    },
    secondary_window: {
      used_percent: 30,
      limit_window_seconds: 604800,
      reset_after_seconds: 600000,
      reset_at: 1773867259,
    },
  },
  code_review_rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 0,
      limit_window_seconds: 604800,
      reset_after_seconds: 604800,
      reset_at: 1773867425,
    },
    secondary_window: null,
  },
  additional_rate_limits: [
    {
      limit_name: 'GPT-5.3-Codex-Spark',
      metered_feature: 'codex_bengalfox',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 5,
          limit_window_seconds: 18000,
          reset_after_seconds: 18000,
          reset_at: 1773280625,
        },
        secondary_window: {
          used_percent: 66,
          limit_window_seconds: 604800,
          reset_after_seconds: 446717,
          reset_at: 1773709341,
        },
      },
    },
  ],
  credits: {
    has_credits: false,
    unlimited: false,
    balance: '0',
  },
};

describe('codex-usage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    invalidateCodexUsageCache();
  });

  describe('readCodexAuth', () => {
    it('reads tokens from auth.json', () => {
      mockedReadFileSync.mockReturnValue(JSON.stringify(CODEX_AUTH));

      const auth = readCodexAuth();
      expect(auth).toEqual({
        access_token: 'test-codex-token',
        account_id: 'test-account-id',
      });
      expect(mockedReadFileSync).toHaveBeenCalledWith(
        '/home/testuser/.codex/auth.json',
        'utf-8'
      );
    });

    it('returns null when file missing', () => {
      mockedReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(readCodexAuth()).toBeNull();
    });

    it('returns null when tokens missing', () => {
      mockedReadFileSync.mockReturnValue(JSON.stringify({ auth_mode: 'chatgpt' }));
      expect(readCodexAuth()).toBeNull();
    });

    it('returns null when access_token missing', () => {
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ tokens: { account_id: 'x' } })
      );
      expect(readCodexAuth()).toBeNull();
    });
  });

  describe('fetchCodexUsage', () => {
    beforeEach(() => {
      mockedReadFileSync.mockReturnValue(JSON.stringify(CODEX_AUTH));
    });

    it('fetches and normalizes usage data', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => CODEX_USAGE_RAW,
      });

      const result = await fetchCodexUsage();
      expect(result).not.toBeNull();
      expect(result!.plan_type).toBe('pro');

      // Global limits
      expect(result!.five_hour).toEqual({
        utilization: 10,
        resets_at: new Date(1773280459 * 1000).toISOString(),
      });
      expect(result!.seven_day).toEqual({
        utilization: 30,
        resets_at: new Date(1773867259 * 1000).toISOString(),
      });

      // Per-model
      expect(result!.models['GPT-5.3-Codex-Spark']).toBeDefined();
      expect(result!.models['GPT-5.3-Codex-Spark'].five_hour!.utilization).toBe(5);
      expect(result!.models['GPT-5.3-Codex-Spark'].seven_day!.utilization).toBe(66);
    });

    it('sends correct auth headers', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => CODEX_USAGE_RAW,
      });

      await fetchCodexUsage();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://chatgpt.com/backend-api/wham/usage',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer test-codex-token',
            'chatgpt-account-id': 'test-account-id',
          },
        })
      );
    });

    it('caches results', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => CODEX_USAGE_RAW,
      });

      await fetchCodexUsage();
      await fetchCodexUsage();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('invalidateCodexUsageCache forces fresh fetch', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => CODEX_USAGE_RAW,
      });

      await fetchCodexUsage();
      invalidateCodexUsageCache();
      await fetchCodexUsage();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('returns null when no credentials', async () => {
      mockedReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const result = await fetchCodexUsage();
      expect(result).toBeNull();
    });

    it('returns null on non-ok response', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 401 });
      const result = await fetchCodexUsage();
      expect(result).toBeNull();
    });

    it('returns null on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      const result = await fetchCodexUsage();
      expect(result).toBeNull();
    });

    it('handles missing additional_rate_limits', async () => {
      const raw = { ...CODEX_USAGE_RAW, additional_rate_limits: [] };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => raw,
      });

      const result = await fetchCodexUsage();
      expect(result!.models).toEqual({});
    });

    it('handles null secondary_window', async () => {
      const raw = {
        ...CODEX_USAGE_RAW,
        rate_limit: {
          ...CODEX_USAGE_RAW.rate_limit,
          secondary_window: null,
        },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => raw,
      });

      const result = await fetchCodexUsage();
      expect(result!.seven_day).toBeNull();
    });
  });

  describe('analyzeCodexUsage', () => {
    const makeUsage = (overrides: Partial<CodexUsageResponse> = {}): CodexUsageResponse => ({
      plan_type: 'pro',
      five_hour: { utilization: 10, resets_at: '2099-01-01T00:00:00Z' },
      seven_day: { utilization: 20, resets_at: '2099-01-01T00:00:00Z' },
      models: {},
      ...overrides,
    });

    it('not exhausted when under threshold', () => {
      const result = analyzeCodexUsage(makeUsage());
      expect(result.isExhausted).toBe(false);
      expect(result.utilization).toBe(20);
    });

    it('exhausted when global bucket >= 99%', () => {
      const result = analyzeCodexUsage(
        makeUsage({ seven_day: { utilization: 99, resets_at: '2099-01-01T00:00:00Z' } })
      );
      expect(result.isExhausted).toBe(true);
      expect(result.limitingBucket).toBe('seven_day');
    });

    it('not exhausted at 95% (below 99% threshold)', () => {
      const result = analyzeCodexUsage(
        makeUsage({ seven_day: { utilization: 95, resets_at: '2099-01-01T00:00:00Z' } })
      );
      expect(result.isExhausted).toBe(false);
    });

    it('exhausted when per-model bucket >= 99%', () => {
      const result = analyzeCodexUsage(
        makeUsage({
          models: {
            'GPT-5.3-Codex-Spark': {
              five_hour: { utilization: 5, resets_at: '2099-01-01T00:00:00Z' },
              seven_day: { utilization: 99, resets_at: '2099-01-01T00:00:00Z' },
            },
          },
        }),
        'spark'
      );
      expect(result.isExhausted).toBe(true);
      expect(result.limitingBucket).toContain('Spark');
    });

    it('ignores model buckets when no model specified', () => {
      const result = analyzeCodexUsage(
        makeUsage({
          models: {
            'GPT-5.3-Codex-Spark': {
              five_hour: null,
              seven_day: { utilization: 99, resets_at: '2099-01-01T00:00:00Z' },
            },
          },
        })
      );
      // Without model param, only global buckets are checked
      expect(result.isExhausted).toBe(false);
    });

    it('picks earliest reset among exhausted buckets', () => {
      const result = analyzeCodexUsage(
        makeUsage({
          five_hour: { utilization: 99, resets_at: '2099-01-01T01:00:00Z' },
          seven_day: { utilization: 99, resets_at: '2099-01-01T00:00:00Z' },
        })
      );
      expect(result.resetsAt).toEqual(new Date('2099-01-01T00:00:00Z'));
    });
  });

  describe('checkCodexUsage', () => {
    beforeEach(() => {
      mockedReadFileSync.mockReturnValue(JSON.stringify(CODEX_AUTH));
    });

    it('returns analysis when fetch succeeds', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => CODEX_USAGE_RAW,
      });

      const result = await checkCodexUsage();
      expect(result).not.toBeNull();
      expect(result!.isExhausted).toBe(false);
    });

    it('detects model-specific exhaustion', async () => {
      const raw = {
        ...CODEX_USAGE_RAW,
        additional_rate_limits: [
          {
            ...CODEX_USAGE_RAW.additional_rate_limits[0],
            rate_limit: {
              ...CODEX_USAGE_RAW.additional_rate_limits[0].rate_limit,
              secondary_window: {
                used_percent: 99,
                limit_window_seconds: 604800,
                reset_after_seconds: 100000,
                reset_at: 1773709341,
              },
            },
          },
        ],
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => raw,
      });

      const result = await checkCodexUsage('spark');
      expect(result).not.toBeNull();
      expect(result!.isExhausted).toBe(true);
    });

    it('returns null when fetch fails', async () => {
      mockedReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const result = await checkCodexUsage();
      expect(result).toBeNull();
    });
  });
});
