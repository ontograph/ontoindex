import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampSuperParams, validateSuperParams } from '../../../src/mcp/super/dispatch.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../../src/mcp/super/tool-definitions.js';

afterEach(() => vi.unstubAllEnvs());

describe('super argument limits', () => {
  it('rejects 3 MB strings and accepts 1 MB strings', () => {
    vi.stubEnv('ONTOINDEX_MAX_ARG_CHARS', '');
    expect(() => validateSuperParams('gn_explore', { query: 'x'.repeat(3 * 1024 * 1024) })).toThrow(
      'Invalid arguments for gn_explore: query: string longer than 2097152 characters',
    );
    expect(() =>
      validateSuperParams('gn_explore', { query: 'x'.repeat(1024 * 1024) }),
    ).not.toThrow();
  });

  it('bounds string array items', () => {
    vi.stubEnv('ONTOINDEX_MAX_ARG_CHARS', '2048');
    expect(() => validateSuperParams('gn_help', { evidenceClasses: ['x'.repeat(2049)] })).toThrow(
      'evidenceClasses[0]: string longer than 2048 characters',
    );
  });

  it('reads the configured limit each call', () => {
    vi.stubEnv('ONTOINDEX_MAX_ARG_CHARS', '2048');
    expect(() => validateSuperParams('gn_explore', { query: 'x'.repeat(2049) })).toThrow(
      '2048 characters',
    );
  });

  it.each(['garbage', '2048oops', '2048.5', '1023', '67108865', ''])(
    'falls back for invalid limit %s',
    (limit) => {
      vi.stubEnv('ONTOINDEX_MAX_ARG_CHARS', limit);
      expect(() => validateSuperParams('gn_explore', { query: 'x'.repeat(2049) })).not.toThrow();
    },
  );

  it.each([
    ['gn_help', 'limit'],
    ['gn_docs', 'maxItems'],
  ] as const)('clamps %s.%s without mutation', (name, key) => {
    for (const [value, expected] of [
      [-1, 1],
      [1e9, 100],
      [30, 30],
    ]) {
      const original = { [key]: value, unknown: 'keep' };
      expect(clampSuperParams(name, original)).toEqual({ [key]: expected, unknown: 'keep' });
      expect(original[key]).toBe(value);
      expect(clampSuperParams(name, original)).not.toBe(original);
    }
    expect(clampSuperParams(name, { [key]: 'oops' })).toEqual({ [key]: 'oops' });
    expect(clampSuperParams(name, {})).toEqual({});
  });

  it('declares defaults within their numeric bounds', () => {
    for (const tool of ONTOINDEX_SUPER_TOOLS) {
      for (const property of Object.values(tool.inputSchema.properties)) {
        if (typeof property.default !== 'number') continue;
        if (property.minimum !== undefined)
          expect(property.default).toBeGreaterThanOrEqual(property.minimum);
        if (property.maximum !== undefined)
          expect(property.default).toBeLessThanOrEqual(property.maximum);
      }
    }
  });
});

describe('shared call-tool string guard', () => {
  it('flags oversize top-level strings and array items for any tool kind', async () => {
    const { findOversizedArgument } = await import('../../../src/mcp/shared/arg-limits.js');
    vi.stubEnv('ONTOINDEX_MAX_ARG_CHARS', '2048');
    expect(findOversizedArgument({ action: 'semantic', query: 'x'.repeat(2049) })).toBe(
      'query: string longer than 2048 characters',
    );
    expect(findOversizedArgument({ targets: ['ok', 'x'.repeat(2049)] })).toBe(
      'targets[1]: string longer than 2048 characters',
    );
    expect(findOversizedArgument({ query: 'x'.repeat(2048), n: 5 })).toBeUndefined();
  });
});
