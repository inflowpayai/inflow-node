import { describe, expect, it, vi } from 'vitest';
import { McpClient as FoundationMcpClient } from 'mppx/mcp/client';

import { McpClient } from '../../src/mcp/index.js';

describe('MCP client entrypoint', () => {
  it('re-exports the foundation MCP client without a local behavior fork', () => {
    expect(McpClient.wrap).toBe(FoundationMcpClient.wrap);
  });

  it('exposes the foundation in-place wrapper', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    const client = { callTool };

    const wrapped = McpClient.wrap(client, { methods: [] });
    const result = await wrapped.callTool({ name: 'free-tool' });

    expect(wrapped).toBe(client);
    expect(callTool).toHaveBeenCalledWith({ name: 'free-tool' }, undefined, undefined);
    expect(result).toMatchObject({ content: [], receipt: undefined });
  });
});
