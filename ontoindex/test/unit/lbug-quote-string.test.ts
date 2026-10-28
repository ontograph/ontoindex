import { describe, expect, it } from 'vitest';
import { quoteLbugString } from '../../src/core/lbug/quote-string.js';

describe('quoteLbugString', () => {
  it('escapes backslashes before quotes so a trailing backslash cannot close the literal', () => {
    expect(quoteLbugString("C:\\ext\\it's")).toBe("C:\\\\ext\\\\it\\'s");
    expect(quoteLbugString('\\')).toBe('\\\\');
  });

  it('leaves ordinary POSIX paths unchanged', () => {
    expect(quoteLbugString('/home/u/.lbug/extension/fts.lbug_extension')).toBe(
      '/home/u/.lbug/extension/fts.lbug_extension',
    );
  });
});
