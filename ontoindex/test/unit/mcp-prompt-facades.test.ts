import { describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMCPServer } from '../../src/mcp/server.js';

describe('MCP impact prompt', () => {
  it('uses public facades with required actions and preserves diff arguments', async () => {
    const spy = vi.spyOn(Server.prototype, 'setRequestHandler');
    try {
      createMCPServer({} as any);
      const handler = spy.mock.calls.find(([schema]) => schema === GetPromptRequestSchema)?.[1];
      expect(handler).toBeDefined();
      const result = await (handler as any)({
        params: { name: 'detect_impact', arguments: { scope: 'compare', base_ref: 'main' } },
      });
      const text = result.messages[0].content.text;
      expect(text).toContain('impact({"action":"diff","scope":"compare","base_ref":"main"})');
      expect(text).toContain('inspect({action: "context", name: "<symbol>"})');
      expect(text).toContain(
        'impact({action: "symbol", target: "<symbol>", direction: "upstream"})',
      );
      expect(text).not.toContain('detect_changes(');
    } finally {
      spy.mockRestore();
    }
  });
});
