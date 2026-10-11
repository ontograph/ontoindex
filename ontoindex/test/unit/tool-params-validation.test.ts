import { describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { TOOL_SCHEMAS } from '../../src/mcp/local/tool-params.js';
import { INTERNAL_TOOL_HANDLERS } from '../../src/mcp/tools.js';

describe('internal tool argument validation', () => {
  it.each([
    ['query', { query: 'auth', limit: '10' }, 'limit'],
    ['replace_symbol', { uid: 'Function:foo', confirm: 'yes' }, 'confirm'],
    ['query', { query: 'auth', limit: 101 }, 'limit'],
    ['sandbox', { action: 'publish' }, 'action'],
    ['impact', { target: 'x', direction: 'sideways' }, 'direction'],
    ['impact_batch', { targets: ['x'], direction: 'sideways' }, 'direction'],
  ])('rejects invalid %s arguments before dispatch', async (tool, params, field) => {
    await expect(new LocalBackend().callTool(tool, params)).rejects.toThrow(
      `Invalid arguments for ${tool}: ${field}:`,
    );
  });

  it.each([
    ['impact', { target: 'x' }],
    ['impact_batch', { targets: ['x'] }],
  ])('accepts omitted direction for %s without injecting defaults', async (tool, params) => {
    const backend = new LocalBackend();
    const dispatch = vi.spyOn(backend as any, 'dispatchRepoTool').mockResolvedValue('ok');
    await expect(backend.callTool(tool, params)).resolves.toBe('ok');
    expect(dispatch).toHaveBeenCalledWith(tool, params);
  });

  it('limits validation errors to the first three issues', async () => {
    await expect(
      new LocalBackend().callTool('query', {
        query: 1,
        limit: '10',
        max_symbols: '10',
        include_content: 'yes',
      }),
    ).rejects.toThrow(/^Invalid arguments for query: query: .*; limit: .*; max_symbols: [^;]+$/);
  });

  it('passes normalized original arguments without stripping extras or injecting defaults', async () => {
    const backend = new LocalBackend();
    const dispatch = vi.spyOn(backend as any, 'dispatchRepoTool').mockResolvedValue('ok');
    const params = { nodeId: 'Function:foo', dry_run: true, extra: { retained: true } };
    await expect(backend.callTool('replace_symbol', params)).resolves.toBe('ok');
    expect(dispatch).toHaveBeenCalledWith('replace_symbol', {
      ...params,
      uid: 'Function:foo',
      target_uid: 'Function:foo',
    });
    const passed = dispatch.mock.calls[0][1] as Record<string, unknown>;
    expect(passed).not.toHaveProperty('confirm');
    expect(passed.extra).toBe(params.extra);
    expect(params).not.toHaveProperty('uid');
  });

  it('leaves tools without internal schemas on their existing dispatch path', async () => {
    const backend = new LocalBackend();
    const dispatch = vi.spyOn(backend as any, 'dispatchRepoTool').mockResolvedValue('ok');
    const params = { limit: 'not-an-internal-parameter' };
    await expect(backend.callTool('gn_diagnose', params)).resolves.toBe('ok');
    expect(dispatch).toHaveBeenCalledWith('gn_diagnose', params);
  });

  for (const tool of INTERNAL_TOOL_HANDLERS) {
    const schema = TOOL_SCHEMAS[tool.name];
    if (!schema) continue;

    it(`${tool.name}: advertises every Zod-required input property as required`, () => {
      for (const [name, field] of Object.entries(schema.shape)) {
        if (!field.isOptional()) expect(tool.inputSchema.required).toContain(name);
      }
    });

    it(`${tool.name}: declares every advertised input property in Zod`, () => {
      for (const name of Object.keys(tool.inputSchema.properties)) {
        expect(schema.shape, `${tool.name}.${name}`).toHaveProperty(name);
      }
    });

    it(`${tool.name}: accepts advertised types, enum values, defaults, and bounds`, () => {
      for (const [name, property] of Object.entries(tool.inputSchema.properties)) {
        const field = schema.shape[name];
        const types = Array.isArray(property.type) ? property.type : [property.type];
        const values: unknown[] = property.enum ? [...property.enum] : [];
        if ('default' in property) values.push(property.default);
        if (property.minimum !== undefined) values.push(property.minimum);
        if (property.maximum !== undefined) values.push(property.maximum);
        if (!property.enum) {
          for (const type of types) {
            // Impact directions only support upstream/downstream despite their legacy string declaration.
            if (type === 'string') values.push(name === 'direction' ? 'upstream' : 'sample');
            if (type === 'boolean') values.push(true, false);
            if (type === 'number') values.push(property.minimum ?? 1);
            if (type === 'array') values.push([]);
            if (type === 'object') values.push({});
            if (type === 'null') values.push(null);
          }
        }
        for (const value of values) {
          expect(
            field.safeParse(value).success,
            `${tool.name}.${name}: ${JSON.stringify(value)}`,
          ).toBe(true);
        }
      }
    });
  }
});
