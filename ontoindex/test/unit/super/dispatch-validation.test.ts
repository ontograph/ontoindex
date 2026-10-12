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
  it.each([
    ['gn_taint_trace', { source: 'input', sink: 'output' }],
    ['gn_taint_trace', { sourceName: 'input', sinkName: 'output' }],
    ['gn_taint_trace', { source: 'input', sinkName: 'output' }],
    ['gn_taint_trace', { sourceName: 'input', sink: 'output' }],
    ['gn_simulate_fault', { target: 'call' }],
    ['gn_simulate_fault', { targetCall: 'call' }],
  ] as const)('accepts canonical and alias arguments for %s', (name, params) => {
    expect(() => validateSuperParams(name, params)).not.toThrow();
  });
  it.each([
    ['gn_taint_trace', {}, 'source or sourceName: Required'],
    ['gn_taint_trace', { sourceName: 'input' }, 'sink or sinkName: Required'],
    ['gn_taint_trace', { sinkName: 'output' }, 'source or sourceName: Required'],
    ['gn_simulate_fault', {}, 'target or targetCall: Required'],
  ] as const)('rejects missing argument families for %s', (name, params, issue) => {
    expect(() => validateSuperParams(name, params)).toThrow(issue);
  });
  it.each([
    [
      'gn_taint_trace',
      {
        source: 'canonical',
        sourceName: 'alias',
        sink: 'canonical',
        sinkName: 'alias',
        extra: 'retained',
      },
    ],
    ['gn_simulate_fault', { target: 'canonical', targetCall: 'alias', extra: 'retained' }],
  ] as const)('preserves conflicting arguments for %s', (name, params) => {
    const original = { ...params };
    Object.freeze(params);
    expect(() => validateSuperParams(name, params)).not.toThrow();
    expect(params).toEqual(original);
  });
  for (const [name, params, fields] of [
    [
      'gn_taint_trace',
      { source: 'input', sourceName: 'input', sink: 'output', sinkName: 'output' },
      ['source', 'sourceName', 'sink', 'sinkName'],
    ],
    ['gn_simulate_fault', { target: 'call', targetCall: 'call' }, ['target', 'targetCall']],
  ] as const) {
    for (const field of fields) {
      it.each([undefined, null, 1, false, [], {}])(
        `rejects invalid ${name}.${field} even when its other name is valid: %j`,
        (value) => {
          expect(() => validateSuperParams(name, { ...params, [field]: value })).toThrow(
            `${field}: expected string`,
          );
        },
      );
    }
  }
  for (const tool of ONTOINDEX_SUPER_TOOLS) {
    it(`accepts required advertised inputs for ${tool.name}`, () => {
      const params: Record<string, unknown> = {};
      const requiredKeys = [
        ...tool.inputSchema.required,
        ...(tool.inputSchema.anyOf?.[0]?.required ?? []),
        ...(tool.inputSchema.allOf?.flatMap((clause) => clause.anyOf[0]?.required ?? []) ?? []),
      ];
      for (const key of requiredKeys) {
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
