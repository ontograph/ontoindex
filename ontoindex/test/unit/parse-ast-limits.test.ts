import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PARSE_MAX_AST_DEPTH,
  DEFAULT_PARSE_MAX_AST_NODES,
  getParseMaxAstDepth,
  getParseMaxAstNodes,
} from '../../src/core/ingestion/constants.js';

afterEach(() => vi.unstubAllEnvs());

describe('AST limit defaults', () => {
  it('exports unlimited defaults', () => {
    expect(DEFAULT_PARSE_MAX_AST_NODES).toBeNull();
    expect(DEFAULT_PARSE_MAX_AST_DEPTH).toBeNull();
  });
});

describe.each([
  ['ONTOINDEX_PARSE_MAX_AST_NODES', getParseMaxAstNodes],
  ['ONTOINDEX_PARSE_MAX_AST_DEPTH', getParseMaxAstDepth],
] as const)('%s', (envName, getLimit) => {
  it.each([undefined, '', ' ', '\t\n'])('has no ceiling for %j', (raw) => {
    vi.stubEnv(envName, raw);
    expect(getLimit()).toBeNull();
  });

  it.each(['0', '0.0', ' 0 '])('disables the guard for %j', (raw) => {
    vi.stubEnv(envName, raw);
    expect(getLimit()).toBeNull();
  });

  it.each([
    ['1', 1],
    ['250', 250],
    [' 4000 ', 4000],
    ['12.9', 12],
    ['0.5', 1],
  ])('uses the configured positive limit %j as %i', (raw, expected) => {
    vi.stubEnv(envName, raw);
    expect(getLimit()).toBe(expected);
  });

  it.each(['invalid', '-1', '-0.5', 'NaN', 'Infinity', '-Infinity'])(
    'falls back to unlimited for invalid value %j',
    (raw) => {
      vi.stubEnv(envName, raw);
      expect(getLimit()).toBeNull();
    },
  );
});
