import { describe, expect, it, vi } from 'vitest';
import { dispatchFacade } from '../../src/mcp/facade/dispatch.js';
import { ONTOINDEX_FACADE_TOOLS } from '../../src/mcp/facade/tool-definitions.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';

describe('facade operation mapping', () => {
  it.each(['get', 'set', 'list'])(
    'maps session operation %s to the backend action',
    async (operation) => {
      const callTool = vi.fn(async () => ({ ok: true }));
      const args = { action: 'session', operation, session_id: 'x' };

      await dispatchFacade('manage', 'session', args, { callTool } as unknown as LocalBackend);

      expect(callTool).toHaveBeenCalledWith('session', { action: operation, session_id: 'x' });
      expect(args).toEqual({ action: 'session', operation, session_id: 'x' });
    },
  );

  it.each([undefined, null, 'stage', 'session', '', 1])(
    'rejects invalid session operation %s before dispatch',
    async (operation) => {
      const callTool = vi.fn();

      await expect(
        dispatchFacade('manage', 'session', { action: 'session', operation }, {
          callTool,
        } as unknown as LocalBackend),
      ).rejects.toThrow('manage(action: "session") requires operation: "get" | "set" | "list".');
      expect(callTool).not.toHaveBeenCalled();
    },
  );

  it.each([
    { operation: undefined, expected: 'stage' },
    { operation: 'stage', expected: 'stage' },
    { operation: 'apply', expected: 'apply' },
  ])('maps sandbox operation $operation to $expected', async ({ operation, expected }) => {
    const callTool = vi.fn(async () => ({ ok: true }));

    await dispatchFacade('refactor', 'sandbox', { action: 'sandbox', operation, repo: 'fixture' }, {
      callTool,
    } as unknown as LocalBackend);

    expect(callTool).toHaveBeenCalledWith('sandbox', { action: expected, repo: 'fixture' });
  });

  it.each(['list', 'sandbox', '', 1])(
    'rejects invalid sandbox operation %s before dispatch',
    async (operation) => {
      const callTool = vi.fn();

      await expect(
        dispatchFacade('refactor', 'sandbox', { action: 'sandbox', operation }, {
          callTool,
        } as unknown as LocalBackend),
      ).rejects.toThrow('refactor(action: "sandbox") requires operation: "stage" | "apply".');
      expect(callTool).not.toHaveBeenCalled();
    },
  );

  it('preserves unrelated facade actions', async () => {
    const callTool = vi.fn(async () => ({ ok: true }));
    const args = { action: 'route_map', operation: 'list' };

    await dispatchFacade('manage', 'route_map', args, { callTool } as unknown as LocalBackend);

    expect(callTool).toHaveBeenCalledWith('route_map', args);
  });

  it.each([
    { name: 'manage', operations: ['get', 'set', 'list'], action: 'session' },
    { name: 'refactor', operations: ['stage', 'apply'], action: 'sandbox' },
  ])('advertises supported $name operations', ({ name, operations, action }) => {
    const tool = ONTOINDEX_FACADE_TOOLS.find((entry) => entry.name === name)!;

    expect(tool.inputSchema.properties.operation).toMatchObject({
      type: 'string',
      enum: operations,
    });
    expect(tool.inputSchema.properties.operation.description).toContain(action);
    expect(tool.inputSchema.required).toEqual(['action']);
  });
});
