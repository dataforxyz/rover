import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForgejoProvider } from '../providers/forgejo.js';
import { ContextFetchError } from '../errors.js';
import type { IssueMetadata } from '../types.js';

vi.mock('../../git.js', () => ({
  Git: vi.fn().mockImplementation(() => ({
    remoteUrl: vi
      .fn()
      .mockReturnValue('https://fgit.datafor.xyz/aidata/ika-api.git'),
  })),
}));

import { Git } from '../../git.js';

const MockGit = vi.mocked(Git);

describe('ForgejoProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockGit.mockImplementation(
      () =>
        ({
          remoteUrl: vi
            .fn()
            .mockReturnValue('https://fgit.datafor.xyz/aidata/ika-api.git'),
        }) as unknown as Git
    );
    vi.stubGlobal('fetch', vi.fn());
    process.env.FORGEJO_TOKEN = 'test-token';
  });

  afterEach(() => {
    delete process.env.FORGEJO_TOKEN;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses forgejo:issue/15 correctly', () => {
    const provider = new ForgejoProvider(new URL('forgejo:issue/15'), {
      originalUri: 'forgejo:issue/15',
    });
    expect(provider.uri).toBe('forgejo:issue/15');
    expect(provider.scheme).toBe('forgejo');
    expect(provider.supportedTypes).toEqual(['issue']);
  });

  it('throws for invalid URI format', () => {
    expect(
      () =>
        new ForgejoProvider(new URL('forgejo:invalid'), {
          originalUri: 'forgejo:invalid',
        })
    ).toThrow(ContextFetchError);
  });

  it('builds issue context from Forgejo API', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            number: 212,
            title: 'Repository tests',
            body: 'Expand repository coverage',
            state: 'open',
            labels: [{ name: 'rover' }],
            assignees: [{ login: 'rover' }],
            milestone: { title: 'Sprint 1' },
            user: { login: 'alice' },
            created_at: '2026-04-03T00:00:00Z',
            updated_at: '2026-04-03T00:10:00Z',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              body: 'Please cover edge cases too.',
              created_at: '2026-04-03T00:05:00Z',
              user: { login: 'alice' },
            },
          ]),
          { status: 200 }
        )
      );

    const provider = new ForgejoProvider(new URL('forgejo:issue/212'), {
      originalUri: 'forgejo:issue/212',
      trustAllAuthors: true,
    });

    const entries = await provider.build();

    expect(entries).toHaveLength(1);
    expect(entries[0].filename).toBe('forgejo-issue-212.md');
    expect(entries[0].content).toContain('Expand repository coverage');
    expect(entries[0].content).toContain('Please cover edge cases too.');
    expect((entries[0].metadata as IssueMetadata).type).toBe('forgejo:issue');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      'https://fgit.datafor.xyz/api/v1/repos/aidata/ika-api/issues/212'
    );
  });

  it('retries transient fetch failures and preserves the issue context', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:443') }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            number: 212,
            title: 'Repository tests',
            body: 'Expand repository coverage',
            state: 'open',
            labels: [],
            assignees: [],
            user: { login: 'alice' },
            created_at: '2026-04-03T00:00:00Z',
            updated_at: '2026-04-03T00:10:00Z',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), { status: 200 })
      );

    const provider = new ForgejoProvider(new URL('forgejo:issue/212'), {
      originalUri: 'forgejo:issue/212',
      trustAllAuthors: true,
    });

    const entries = await provider.build();

    expect(entries).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('surfaces the underlying network error after retries are exhausted', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockRejectedValue(
      new TypeError('fetch failed', {
        cause: new Error('connect ECONNREFUSED 127.0.0.1:443'),
      })
    );

    const provider = new ForgejoProvider(new URL('forgejo:issue/212'), {
      originalUri: 'forgejo:issue/212',
      trustAllAuthors: true,
    });

    await expect(provider.build()).rejects.toThrow(
      'connect ECONNREFUSED 127.0.0.1:443'
    );
  });
});
