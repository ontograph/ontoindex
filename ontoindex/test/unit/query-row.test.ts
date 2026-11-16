import { describe, expect, it } from 'vitest';
import { queryRowValue } from '../../src/core/lbug/query-row.js';

describe('queryRowValue', () => {
  it.each(['named', 0, false, ''])('prefers a keyed value of %j', (value) => {
    expect(queryRowValue({ name: value, 0: 'fallback' }, 'name', 0)).toBe(value);
    expect(queryRowValue(Object.assign(['fallback'], { name: value }), 'name', 0)).toBe(value);
  });

  it.each([null, undefined])('falls back for a keyed value of %j', (value) => {
    expect(queryRowValue({ name: value, 1: 'fallback' }, 'name', 1)).toBe('fallback');
    expect(queryRowValue(Object.assign(['other', 'fallback'], { name: value }), 'name', 1)).toBe(
      'fallback',
    );
  });

  it('returns undefined when both columns are missing', () => {
    expect(queryRowValue({}, 'missing', 0)).toBeUndefined();
    expect(queryRowValue([], 'missing', 0)).toBeUndefined();
  });
});
