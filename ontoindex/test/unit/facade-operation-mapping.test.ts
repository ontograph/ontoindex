import { describe, expect, it, vi } from 'vitest';
import { dispatchFacade } from '../../src/mcp/facade/dispatch.js';
import { ONTOINDEX_FACADE_TOOLS } from '../../src/mcp/facade/tool-definitions.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';

describe('facade operation mapping', () => {
  it.each([
    { operation: 'get', fields: { session_id: 'x', key: 'plan', repo: 'fixture' } },
    { operation: 'set', fields: { session_id: 'x', key: 'plan', value: 'next', repo: 'fixture' } },
    { operation: 'list', fields: { session_id: 'x', repo: 'fixture' } },
  ])(
    'maps session operation $operation and forwards its fields to the backend',
    async ({ operation, fields }) => {
      const callTool = vi.fn(async () => ({ ok: true }));
      const args = { action: 'session', operation, ...fields };

      await dispatchFacade('manage', 'session', args, { callTool } as unknown as LocalBackend);

      expect(callTool).toHaveBeenCalledWith('session', { action: operation, ...fields });
      expect(args).toEqual({ action: 'session', operation, ...fields });
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

  it.each([{ action: 'route_map' }, { action: 'route_map', operation: 'list' }])(
    'preserves unrelated facade arguments %j',
    async (args) => {
      const callTool = vi.fn(async () => ({ ok: true }));

      await dispatchFacade('manage', 'route_map', args, { callTool } as unknown as LocalBackend);

      expect(callTool).toHaveBeenCalledWith('route_map', args);
    },
  );

  it('advertises the existing session-key contract without requiring session fields for route_map', () => {
    const tool = ONTOINDEX_FACADE_TOOLS.find((entry) => entry.name === 'manage')!;

    expect(tool.inputSchema.properties).toMatchObject({
      session_id: { type: 'string' },
      key: { type: 'string' },
      value: { type: 'string' },
      repo: { type: 'string' },
    });
    expect(tool.description).toContain(
      '"list" requires session_id and lists keys within that session',
    );
    expect(tool.description).toContain('"get" requires session_id/key');
    expect(tool.description).toContain('"set" requires session_id/key/value');
    expect(tool.description).toContain('Session fields are not required for action "route_map"');
    expect(tool.inputSchema.required).toEqual(['action']);
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
