import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultAgentImage } from '../sandbox/container-common.js';

describe('container-common', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the published dev image name for dev builds', () => {
    vi.stubEnv('ROVER_AGENT_IMAGE', '');

    expect(getDefaultAgentImage()).toBe(
      'ghcr.io/endorhq/rover/agent-dev:latest'
    );
  });
});
