import { describe, expect, it } from 'vitest';
import { roverMcpToAcpServer } from '../run.js';
import type { MCP } from 'rover-schemas';

describe('roverMcpToAcpServer', () => {
  it('preserves quoted stdio arguments when parsing commandOrUrl', () => {
    const mcp: MCP = {
      name: 'quoted-stdio',
      transport: 'stdio',
      commandOrUrl:
        'uvx --from "git+https://example.com/repo with spaces" mcp-server',
      envs: ['TOKEN=secret'],
      headers: [],
    };

    const result = roverMcpToAcpServer(mcp);

    expect(result).toMatchObject({
      name: 'quoted-stdio',
      command: 'uvx',
      args: [
        '--from',
        'git+https://example.com/repo with spaces',
        'mcp-server',
      ],
      env: [{ name: 'TOKEN', value: 'secret' }],
    });
  });
});
