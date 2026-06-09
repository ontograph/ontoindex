import { describe, it, expect } from 'vitest';
import { guardResponseSize } from '../../src/mcp/local/response-guard.js';

describe('guardResponseSize', () => {
  it('passes through a payload under 512 KB unchanged', () => {
    const small = 'x'.repeat(1024);
    expect(guardResponseSize(small)).toBe(small);
  });

  it('passes through a payload exactly at the limit', () => {
    const atLimit = 'a'.repeat(512 * 1024);
    expect(guardResponseSize(atLimit)).toBe(atLimit);
  });

  it('truncates a payload over 512 KB and returns truncated:true', () => {
    const big = JSON.stringify({ data: 'z'.repeat(600 * 1024) });
    const out = JSON.parse(guardResponseSize(big));
    expect(out.truncated).toBe(true);
    expect(out.hint).toBe('Reduce limit or add filters');
    expect(typeof out.preview).toBe('string');
    expect(out.preview.length).toBe(2000);
  });

  it('preview contains the start of the original payload', () => {
    const big = 'START' + 'x'.repeat(600 * 1024);
    const out = JSON.parse(guardResponseSize(big));
    expect(out.preview.startsWith('START')).toBe(true);
  });
});
