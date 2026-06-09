import { describe, it, expect } from 'vitest';
import { normalizeLimit } from '../../src/mcp/local/tool-utils.js';

describe('normalizeLimit', () => {
  it('returns default when input is undefined', () => {
    expect(normalizeLimit(undefined, 50, 500)).toBe(50);
  });

  it('clamps to 1 minimum', () => {
    expect(normalizeLimit(-5, 50, 500)).toBe(1);
  });

  it('clamps to max', () => {
    expect(normalizeLimit(9999, 50, 500)).toBe(500);
  });

  it('floors fractional inputs', () => {
    expect(normalizeLimit(7.9, 50, 500)).toBe(7);
  });

  it('returns default for NaN input', () => {
    expect(normalizeLimit('bad', 50, 500)).toBe(50);
  });

  it('passes through a valid value unchanged', () => {
    expect(normalizeLimit(200, 50, 500)).toBe(200);
  });
});
