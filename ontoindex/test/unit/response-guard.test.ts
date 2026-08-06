import { describe, it, expect } from 'vitest';
import { guardResponseSize } from '../../src/mcp/local/response-guard.js';

describe('guardResponseSize', () => {
  it('passes through a payload under 48 KiB unchanged', () => {
    const small = 'x'.repeat(1024);
    expect(guardResponseSize(small)).toBe(small);
  });

  it('passes through a payload exactly at the limit', () => {
    const atLimit = 'a'.repeat(48 * 1024);
    expect(guardResponseSize(atLimit)).toBe(atLimit);
  });

  it('truncates a payload over 48 KiB and returns truncated:true', () => {
    const big = JSON.stringify({ data: 'z'.repeat(64 * 1024) });
    const out = JSON.parse(guardResponseSize(big));
    expect(out.truncated).toBe(true);
    expect(out.responseBudget).toMatchObject({
      mode: 'guarded-preview',
      truncated: true,
      retryHint: 'Reduce limit or add filters',
    });
    expect(out.responseBudget.estimatedBytes).toBeGreaterThan(out.preview.length);
    expect(out.hint).toBe('Reduce limit or add filters');
    expect(typeof out.preview).toBe('string');
    expect(out.preview.length).toBe(2000);
  });

  it('preview contains the start of the original payload', () => {
    const big = 'START' + 'x'.repeat(64 * 1024);
    const out = JSON.parse(guardResponseSize(big));
    expect(out.preview.startsWith('START')).toBe(true);
  });
});
