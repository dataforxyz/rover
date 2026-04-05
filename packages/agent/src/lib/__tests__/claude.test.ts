import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgent } from '../agents/claude.js';

describe('ClaudeAgent credential requirements', () => {
  const originalProxyUrl = process.env.ROVER_CLAUDE_PROXY_URL;
  const originalProxyKey = process.env.ROVER_CLAUDE_PROXY_KEY;

  afterEach(() => {
    if (originalProxyUrl === undefined) {
      delete process.env.ROVER_CLAUDE_PROXY_URL;
    } else {
      process.env.ROVER_CLAUDE_PROXY_URL = originalProxyUrl;
    }

    if (originalProxyKey === undefined) {
      delete process.env.ROVER_CLAUDE_PROXY_KEY;
    } else {
      process.env.ROVER_CLAUDE_PROXY_KEY = originalProxyKey;
    }
  });

  it('does not require local Claude config files in proxy mode', () => {
    process.env.ROVER_CLAUDE_PROXY_URL = 'http://proxy';
    process.env.ROVER_CLAUDE_PROXY_KEY = 'secret';

    const agent = new ClaudeAgent();
    const claudeConfig = agent
      .getRequiredCredentials()
      .find(cred => cred.path === '/.claude.json');

    expect(claudeConfig?.required).toBe(false);
  });
});
