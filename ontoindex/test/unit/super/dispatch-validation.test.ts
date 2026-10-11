import { describe, expect, it } from 'vitest';
import {
  dispatchSuper,
  validateSuperParams,
  type SuperTool,
} from '../../../src/mcp/super/dispatch.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../../src/mcp/super/tool-definitions.js';

describe('super argument validation', () => {
  it('rejects string boolean before analysis submission', async () => {
    await expect(
      dispatchSuper('gn_ensure_fresh', { autoAnalyze: 'false' }, 'missing'),
    ).rejects.toThrow('Invalid arguments for gn_ensure_fresh: autoAnalyze:');
  });
  it.each([
    ['gn_explore', { query: 5 }, 'query'],
    ['gn_quality_mode', { level: 'invalid' }, 'level'],
    ['gn_explore', {}, 'query'],
  ] as const)('rejects malformed %s arguments', (name, params, field) => {
    expect(() => validateSuperParams(name, params)).toThrow(
      `Invalid arguments for ${name}: ${field}:`,
    );
  });
  it('allows unknown properties and preserves omitted defaults', () => {
    const params = { query: 'x', extra: { retained: true } };
    validateSuperParams('gn_explore', params);
    expect(params).toEqual({ query: 'x', extra: { retained: true } });
  });
  for (const tool of ONTOINDEX_SUPER_TOOLS) {
    it(`accepts required advertised inputs for ${tool.name}`, () => {
      const params: Record<string, unknown> = {};
      for (const key of tool.inputSchema.required) {
        const property = tool.inputSchema.properties[key];
        const type = Array.isArray(property.type) ? property.type[0] : property.type;
        params[key] =
          property.enum?.[0] ??
          (
            {
              string: 'sample',
              number: 1,
              integer: 1,
              boolean: true,
              array: [],
              object: {},
              null: null,
            } as Record<string, unknown>
          )[type];
      }
      expect(() => validateSuperParams(tool.name as SuperTool, params)).not.toThrow();
    });
    if (
      tool.inputSchema.required.includes('session') &&
      Object.hasOwn(tool.inputSchema.properties, 'sessionId')
    ) {
      it(`accepts sessionId alias without mutating inputs for ${tool.name}`, () => {
        const params: Record<string, unknown> = { sessionId: 'sample' };
        for (const key of tool.inputSchema.required) {
          if (key !== 'session') params[key] = 'sample';
        }
        const original = { ...params };
        expect(() => validateSuperParams(tool.name as SuperTool, params)).not.toThrow();
        expect(params).toEqual(original);
        const { sessionId: _sessionId, ...missing } = params;
        expect(() => validateSuperParams(tool.name as SuperTool, missing)).toThrow(
          'session: Required',
        );
        expect(() =>
          validateSuperParams(tool.name as SuperTool, { ...params, sessionId: 1 }),
        ).toThrow('sessionId: expected string');
        expect(() =>
          validateSuperParams(tool.name as SuperTool, { ...params, session: 1 }),
        ).toThrow('session: expected string');
        expect(() =>
          validateSuperParams(tool.name as SuperTool, {
            ...params,
            session: 'canonical',
            sessionId: 1,
          }),
        ).toThrow('sessionId: expected string');
      });
    }
  }
});
