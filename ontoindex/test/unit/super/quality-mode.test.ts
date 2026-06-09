/**
 * Unit tests for gn_quality_mode super-function (Phase 3 W3c).
 *
 * gnQualityMode is a pure env-var preset switch with no external dependencies,
 * so no mocks are required.  Each test saves / restores process.env to avoid
 * leaking state between cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gnQualityMode } from '../../../src/mcp/super/quality-mode.js';

// ---------------------------------------------------------------------------
// Env-state save / restore
// ---------------------------------------------------------------------------

const WATCHED_KEYS = [
  'ONTOINDEX_INTENT_ENSEMBLE',
  'ONTOINDEX_CITATIONS',
  'ONTOINDEX_LSP_REFERENCES',
  'ONTOINDEX_VEC_POOL_MIN',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {} as Record<string, string | undefined>;
  for (const k of WATCHED_KEYS) {
    savedEnv[k] = process.env[k];
  }
});

afterEach(() => {
  for (const k of WATCHED_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gnQualityMode — fast', () => {
  it('clears ONTOINDEX_INTENT_ENSEMBLE, ONTOINDEX_CITATIONS, ONTOINDEX_LSP_REFERENCES', () => {
    // Pre-set all three so we can verify they get cleared.
    process.env['ONTOINDEX_INTENT_ENSEMBLE'] = '1';
    process.env['ONTOINDEX_CITATIONS'] = '1';
    process.env['ONTOINDEX_LSP_REFERENCES'] = '1';

    const report = gnQualityMode({ level: 'fast' });

    expect(process.env['ONTOINDEX_INTENT_ENSEMBLE']).toBeUndefined();
    expect(process.env['ONTOINDEX_CITATIONS']).toBeUndefined();
    expect(process.env['ONTOINDEX_LSP_REFERENCES']).toBeUndefined();

    expect(report.appliedMode).toBe('fast');
    expect(report.envVarsSet).toEqual({});
    expect(report.envVarsCleared).toEqual(
      expect.arrayContaining([
        'ONTOINDEX_INTENT_ENSEMBLE',
        'ONTOINDEX_CITATIONS',
        'ONTOINDEX_LSP_REFERENCES',
      ]),
    );
    expect(report.envVarsCleared).toHaveLength(3);
  });

  it('does not touch ONTOINDEX_VEC_POOL_MIN', () => {
    process.env['ONTOINDEX_VEC_POOL_MIN'] = '5';

    gnQualityMode({ level: 'fast' });

    expect(process.env['ONTOINDEX_VEC_POOL_MIN']).toBe('5');
  });
});

describe('gnQualityMode — balanced', () => {
  it('sets ONTOINDEX_INTENT_ENSEMBLE=1 and ONTOINDEX_CITATIONS=1, clears LSP', () => {
    process.env['ONTOINDEX_LSP_REFERENCES'] = '1';

    const report = gnQualityMode({ level: 'balanced' });

    expect(process.env['ONTOINDEX_INTENT_ENSEMBLE']).toBe('1');
    expect(process.env['ONTOINDEX_CITATIONS']).toBe('1');
    expect(process.env['ONTOINDEX_LSP_REFERENCES']).toBeUndefined();

    expect(report.appliedMode).toBe('balanced');
    expect(report.envVarsSet).toEqual({
      ONTOINDEX_INTENT_ENSEMBLE: '1',
      ONTOINDEX_CITATIONS: '1',
    });
    expect(report.envVarsCleared).toContain('ONTOINDEX_LSP_REFERENCES');
  });
});

describe('gnQualityMode — thorough', () => {
  it('sets all four env vars including ONTOINDEX_VEC_POOL_MIN=3', () => {
    const report = gnQualityMode({ level: 'thorough' });

    expect(process.env['ONTOINDEX_INTENT_ENSEMBLE']).toBe('1');
    expect(process.env['ONTOINDEX_CITATIONS']).toBe('1');
    expect(process.env['ONTOINDEX_LSP_REFERENCES']).toBe('1');
    expect(process.env['ONTOINDEX_VEC_POOL_MIN']).toBe('3');

    expect(report.appliedMode).toBe('thorough');
    expect(report.envVarsSet).toEqual({
      ONTOINDEX_INTENT_ENSEMBLE: '1',
      ONTOINDEX_CITATIONS: '1',
      ONTOINDEX_LSP_REFERENCES: '1',
      ONTOINDEX_VEC_POOL_MIN: '3',
    });
    expect(report.envVarsCleared).toHaveLength(0);
  });
});

describe('gnQualityMode — return shape', () => {
  it('always returns version: 1', () => {
    const report = gnQualityMode({ level: 'balanced' });
    expect(report.version).toBe(1);
  });

  it('envVarsSet and envVarsCleared are mutually exclusive for the same key', () => {
    const report = gnQualityMode({ level: 'balanced' });
    const setKeys = Object.keys(report.envVarsSet);
    const intersection = report.envVarsCleared.filter((k) => setKeys.includes(k));
    expect(intersection).toHaveLength(0);
  });

  it('duration "until-revert" emits advisory warning but applies mode', () => {
    const report = gnQualityMode({ level: 'balanced', duration: 'until-revert' });

    // Mode still applied.
    expect(process.env['ONTOINDEX_INTENT_ENSEMBLE']).toBe('1');
    expect(process.env['ONTOINDEX_CITATIONS']).toBe('1');

    // Warning present.
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(/until-revert/);
  });

  it('no warnings for default session duration', () => {
    const report = gnQualityMode({ level: 'fast' });
    expect(report.warnings).toHaveLength(0);
  });
});
