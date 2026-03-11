import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs and os before importing the module under test
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
}));

// Mock the agents module for keychain fallback
vi.mock('../../lib/agents/index.js', () => ({
  findKeychainCredentials: vi.fn(),
}));

import { readFileSync } from 'node:fs';
import {
  readClaudeOAuthToken,
  fetchClaudeUsage,
  analyzeUsage,
  checkClaudeUsage,
  invalidateUsageCache,
  resolveClaudeModelFamily,
  getRelevantBuckets,
  type ClaudeUsageResponse,
} from '../claude-usage.js';

const mockedReadFileSync = vi.mocked(readFileSync);

// Shared mock fetch — replaced before every test via stubGlobal
const mockFetch = vi.fn();

describe('claude-usage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    invalidateUsageCache();
  });

  describe('readClaudeOAuthToken', () => {
    it('reads token from credentials file on disk', () => {
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: { accessToken: 'test-token-123' },
        })
      );

      const token = readClaudeOAuthToken();
      expect(token).toBe('test-token-123');
      expect(mockedReadFileSync).toHaveBeenCalledWith(
        '/home/testuser/.claude/.credentials.json',
        'utf-8'
      );
    });

    it('returns null when credentials file does not exist', () => {
      mockedReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const token = readClaudeOAuthToken();
      expect(token).toBeNull();
    });

    it('returns null when credentials file has bad JSON', () => {
      mockedReadFileSync.mockReturnValue('not json');

      const token = readClaudeOAuthToken();
      expect(token).toBeNull();
    });

    it('returns null when credentials file has no accessToken', () => {
      mockedReadFileSync.mockReturnValue(JSON.stringify({ claudeAiOauth: {} }));

      const token = readClaudeOAuthToken();
      expect(token).toBeNull();
    });

    it('returns null when accessToken is empty string', () => {
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ claudeAiOauth: { accessToken: '' } })
      );

      const token = readClaudeOAuthToken();
      expect(token).toBeNull();
    });

    it('returns null when claudeAiOauth is missing', () => {
      mockedReadFileSync.mockReturnValue(JSON.stringify({ other: 'data' }));

      const token = readClaudeOAuthToken();
      expect(token).toBeNull();
    });
  });

  describe('fetchClaudeUsage', () => {
    const mockUsageResponse: ClaudeUsageResponse = {
      five_hour: {
        limit: 1000,
        remaining: 500,
        utilization: 0.5,
        resets_at: '2026-01-15T19:00:00Z',
        expires_at: '2026-01-15T19:00:00Z',
      },
      seven_day: {
        limit: 5000,
        remaining: 2500,
        utilization: 0.5,
        resets_at: '2026-01-22T00:00:00Z',
        expires_at: '2026-01-22T00:00:00Z',
      },
    };

    beforeEach(() => {
      // Provide valid credentials
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: { accessToken: 'test-token' },
        })
      );
    });

    it('fetches usage data from API', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockUsageResponse,
      });

      const result = await fetchClaudeUsage();
      expect(result).toEqual(mockUsageResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/api/oauth/usage',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer test-token',
            'anthropic-beta': 'oauth-2025-04-20',
          },
        })
      );
    });

    it('returns cached data within TTL', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockUsageResponse,
      });

      await fetchClaudeUsage();
      await fetchClaudeUsage();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('invalidateUsageCache forces fresh fetch', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockUsageResponse,
      });

      await fetchClaudeUsage();
      invalidateUsageCache();
      await fetchClaudeUsage();

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('returns null when no credentials available', async () => {
      mockedReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = await fetchClaudeUsage();
      expect(result).toBeNull();
    });

    it('returns null on non-ok HTTP response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
      });

      const result = await fetchClaudeUsage();
      expect(result).toBeNull();
    });

    it('returns null on fetch error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await fetchClaudeUsage();
      expect(result).toBeNull();
    });
  });

  describe('analyzeUsage', () => {
    it('detects exhaustion when utilization >= 95%', () => {
      const usage: ClaudeUsageResponse = {
        five_hour: {
          limit: 1000,
          remaining: 30,
          utilization: 0.97,
          resets_at: '2026-01-15T19:00:00Z',
          expires_at: '2026-01-15T19:00:00Z',
        },
        seven_day: {
          limit: 5000,
          remaining: 2500,
          utilization: 0.5,
          resets_at: '2026-01-22T00:00:00Z',
          expires_at: '2026-01-22T00:00:00Z',
        },
      };

      const result = analyzeUsage(usage);
      expect(result.isExhausted).toBe(true);
      expect(result.limitingBucket).toBe('five_hour');
      expect(result.resetsAt).toEqual(new Date('2026-01-15T19:00:00Z'));
      expect(result.utilization).toBe(0.97);
    });

    it('returns not exhausted when all buckets are below threshold', () => {
      const usage: ClaudeUsageResponse = {
        five_hour: {
          limit: 1000,
          remaining: 200,
          utilization: 0.8,
          resets_at: '2026-01-15T19:00:00Z',
          expires_at: '2026-01-15T19:00:00Z',
        },
        seven_day: {
          limit: 5000,
          remaining: 2500,
          utilization: 0.5,
          resets_at: '2026-01-22T00:00:00Z',
          expires_at: '2026-01-22T00:00:00Z',
        },
      };

      const result = analyzeUsage(usage);
      expect(result.isExhausted).toBe(false);
      expect(result.limitingBucket).toBeNull();
      expect(result.resetsAt).toBeNull();
      expect(result.utilization).toBe(0.8);
    });

    it('picks the earliest reset among exhausted buckets', () => {
      const usage: ClaudeUsageResponse = {
        five_hour: {
          limit: 1000,
          remaining: 10,
          utilization: 0.99,
          resets_at: '2026-01-15T19:00:00Z',
          expires_at: '2026-01-15T19:00:00Z',
        },
        seven_day: {
          limit: 5000,
          remaining: 50,
          utilization: 0.99,
          resets_at: '2026-01-22T00:00:00Z',
          expires_at: '2026-01-22T00:00:00Z',
        },
      };

      const result = analyzeUsage(usage);
      expect(result.isExhausted).toBe(true);
      expect(result.resetsAt).toEqual(new Date('2026-01-15T19:00:00Z'));
      expect(result.limitingBucket).toBe('five_hour');
    });

    it('handles null/undefined buckets gracefully', () => {
      const usage: ClaudeUsageResponse = {
        five_hour: null,
        seven_day: undefined as any,
      };

      const result = analyzeUsage(usage);
      expect(result.isExhausted).toBe(false);
      expect(result.utilization).toBe(0);
      expect(result.limitingBucket).toBeNull();
    });

    it('handles empty response', () => {
      const result = analyzeUsage({});
      expect(result.isExhausted).toBe(false);
      expect(result.utilization).toBe(0);
    });

    it('detects exhaustion at exactly 95% threshold', () => {
      const usage: ClaudeUsageResponse = {
        five_hour: {
          limit: 1000,
          remaining: 50,
          utilization: 0.95,
          resets_at: '2026-01-15T19:00:00Z',
          expires_at: '2026-01-15T19:00:00Z',
        },
      };

      const result = analyzeUsage(usage);
      expect(result.isExhausted).toBe(true);
    });
  });

  describe('resolveClaudeModelFamily', () => {
    it('returns null for undefined', () => {
      expect(resolveClaudeModelFamily(undefined)).toBeNull();
    });

    it('returns null for unrecognized model', () => {
      expect(resolveClaudeModelFamily('gpt-4')).toBeNull();
    });

    it('resolves "opus" variants', () => {
      expect(resolveClaudeModelFamily('opus')).toBe('opus');
      expect(resolveClaudeModelFamily('claude-opus-4')).toBe('opus');
      expect(resolveClaudeModelFamily('claude-3-opus')).toBe('opus');
      expect(resolveClaudeModelFamily('OPUS')).toBe('opus');
    });

    it('resolves "sonnet" variants', () => {
      expect(resolveClaudeModelFamily('sonnet')).toBe('sonnet');
      expect(resolveClaudeModelFamily('claude-sonnet-4')).toBe('sonnet');
      expect(resolveClaudeModelFamily('claude-3-5-sonnet')).toBe('sonnet');
      expect(resolveClaudeModelFamily('SONNET')).toBe('sonnet');
    });

    it('resolves "haiku" variants', () => {
      expect(resolveClaudeModelFamily('haiku')).toBe('haiku');
      expect(resolveClaudeModelFamily('claude-haiku-3')).toBe('haiku');
      expect(resolveClaudeModelFamily('HAIKU')).toBe('haiku');
    });
  });

  describe('getRelevantBuckets', () => {
    it('returns opus-relevant buckets', () => {
      expect(getRelevantBuckets('opus')).toEqual([
        'five_hour',
        'seven_day',
        'seven_day_opus',
      ]);
    });

    it('returns sonnet-relevant buckets', () => {
      expect(getRelevantBuckets('sonnet')).toEqual([
        'five_hour',
        'seven_day',
        'seven_day_sonnet',
      ]);
    });

    it('returns haiku-relevant buckets', () => {
      expect(getRelevantBuckets('haiku')).toEqual(['five_hour', 'seven_day']);
    });

    it('returns all buckets for null (unknown model)', () => {
      expect(getRelevantBuckets(null)).toEqual([
        'five_hour',
        'seven_day',
        'seven_day_sonnet',
        'seven_day_opus',
      ]);
    });
  });

  describe('analyzeUsage with model', () => {
    it('sonnet task is not blocked by opus exhaustion', () => {
      const usage: ClaudeUsageResponse = {
        five_hour: {
          limit: 1000,
          remaining: 500,
          utilization: 0.5,
          resets_at: '2026-01-15T19:00:00Z',
          expires_at: '2026-01-15T19:00:00Z',
        },
        seven_day: {
          limit: 5000,
          remaining: 2500,
          utilization: 0.5,
          resets_at: '2026-01-22T00:00:00Z',
          expires_at: '2026-01-22T00:00:00Z',
        },
        seven_day_opus: {
          limit: 1000,
          remaining: 5,
          utilization: 0.99,
          resets_at: '2026-01-22T00:00:00Z',
          expires_at: '2026-01-22T00:00:00Z',
        },
      };

      const result = analyzeUsage(usage, 'sonnet');
      expect(result.isExhausted).toBe(false);
    });

    it('opus task IS blocked by opus exhaustion', () => {
      const usage: ClaudeUsageResponse = {
        five_hour: {
          limit: 1000,
          remaining: 500,
          utilization: 0.5,
          resets_at: '2026-01-15T19:00:00Z',
          expires_at: '2026-01-15T19:00:00Z',
        },
        seven_day: {
          limit: 5000,
          remaining: 2500,
          utilization: 0.5,
          resets_at: '2026-01-22T00:00:00Z',
          expires_at: '2026-01-22T00:00:00Z',
        },
        seven_day_opus: {
          limit: 1000,
          remaining: 5,
          utilization: 0.99,
          resets_at: '2026-01-22T00:00:00Z',
          expires_at: '2026-01-22T00:00:00Z',
        },
      };

      const result = analyzeUsage(usage, 'opus');
      expect(result.isExhausted).toBe(true);
      expect(result.limitingBucket).toBe('seven_day_opus');
    });

    it('opus task is not blocked by sonnet exhaustion', () => {
      const usage: ClaudeUsageResponse = {
        five_hour: {
          limit: 1000,
          remaining: 500,
          utilization: 0.5,
          resets_at: '2026-01-15T19:00:00Z',
          expires_at: '2026-01-15T19:00:00Z',
        },
        seven_day: {
          limit: 5000,
          remaining: 2500,
          utilization: 0.5,
          resets_at: '2026-01-22T00:00:00Z',
          expires_at: '2026-01-22T00:00:00Z',
        },
        seven_day_sonnet: {
          limit: 3000,
          remaining: 10,
          utilization: 0.99,
          resets_at: '2026-01-22T00:00:00Z',
          expires_at: '2026-01-22T00:00:00Z',
        },
      };

      const result = analyzeUsage(usage, 'opus');
      expect(result.isExhausted).toBe(false);
    });

    it('no model checks all buckets (conservative)', () => {
      const usage: ClaudeUsageResponse = {
        five_hour: {
          limit: 1000,
          remaining: 500,
          utilization: 0.5,
          resets_at: '2026-01-15T19:00:00Z',
          expires_at: '2026-01-15T19:00:00Z',
        },
        seven_day: {
          limit: 5000,
          remaining: 2500,
          utilization: 0.5,
          resets_at: '2026-01-22T00:00:00Z',
          expires_at: '2026-01-22T00:00:00Z',
        },
        seven_day_opus: {
          limit: 1000,
          remaining: 5,
          utilization: 0.99,
          resets_at: '2026-01-22T00:00:00Z',
          expires_at: '2026-01-22T00:00:00Z',
        },
      };

      const result = analyzeUsage(usage);
      expect(result.isExhausted).toBe(true);
      expect(result.limitingBucket).toBe('seven_day_opus');
    });

    it('haiku task ignores model-specific buckets', () => {
      const usage: ClaudeUsageResponse = {
        five_hour: {
          limit: 1000,
          remaining: 500,
          utilization: 0.5,
          resets_at: '2026-01-15T19:00:00Z',
          expires_at: '2026-01-15T19:00:00Z',
        },
        seven_day: {
          limit: 5000,
          remaining: 2500,
          utilization: 0.5,
          resets_at: '2026-01-22T00:00:00Z',
          expires_at: '2026-01-22T00:00:00Z',
        },
        seven_day_opus: {
          limit: 1000,
          remaining: 5,
          utilization: 0.99,
          resets_at: '2026-01-22T00:00:00Z',
          expires_at: '2026-01-22T00:00:00Z',
        },
        seven_day_sonnet: {
          limit: 3000,
          remaining: 10,
          utilization: 0.99,
          resets_at: '2026-01-22T00:00:00Z',
          expires_at: '2026-01-22T00:00:00Z',
        },
      };

      const result = analyzeUsage(usage, 'haiku');
      expect(result.isExhausted).toBe(false);
    });
  });

  describe('checkClaudeUsage', () => {
    it('returns analysis when fetch succeeds', async () => {
      const mockUsage: ClaudeUsageResponse = {
        five_hour: {
          limit: 1000,
          remaining: 10,
          utilization: 0.99,
          resets_at: '2026-01-15T19:00:00Z',
          expires_at: '2026-01-15T19:00:00Z',
        },
      };

      mockedReadFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: { accessToken: 'test-token' },
        })
      );

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockUsage,
      });

      const result = await checkClaudeUsage();
      expect(result).not.toBeNull();
      expect(result!.isExhausted).toBe(true);
    });

    it('passes model through to analyzeUsage', async () => {
      const mockUsage: ClaudeUsageResponse = {
        five_hour: {
          limit: 1000,
          remaining: 500,
          utilization: 0.5,
          resets_at: '2026-01-15T19:00:00Z',
          expires_at: '2026-01-15T19:00:00Z',
        },
        seven_day_opus: {
          limit: 1000,
          remaining: 5,
          utilization: 0.99,
          resets_at: '2026-01-22T00:00:00Z',
          expires_at: '2026-01-22T00:00:00Z',
        },
      };

      mockedReadFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: { accessToken: 'test-token' },
        })
      );

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockUsage,
      });

      // With sonnet model, opus exhaustion should not matter
      const result = await checkClaudeUsage('sonnet');
      expect(result).not.toBeNull();
      expect(result!.isExhausted).toBe(false);
    });

    it('returns null when fetch fails', async () => {
      mockedReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = await checkClaudeUsage();
      expect(result).toBeNull();
    });
  });
});
