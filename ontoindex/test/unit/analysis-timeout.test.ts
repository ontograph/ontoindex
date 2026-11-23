import { describe, expect, it } from 'vitest';
import { analysisTimeoutMs } from '../../src/core/analysis/analysis-timeout.js';

describe('analysisTimeoutMs', () => {
  it('defaults to 30 minutes when the setting is missing or invalid', () => {
    for (const value of [undefined, '', '0', '-1', '1.5', 'abc', '2147483648']) {
      expect(analysisTimeoutMs(value)).toBe(1_800_000);
    }
  });

  it('accepts a positive integer delay within the Node timer limit', () => {
    expect(analysisTimeoutMs('7200000')).toBe(7_200_000);
    expect(analysisTimeoutMs('2147483647')).toBe(2_147_483_647);
  });
});
