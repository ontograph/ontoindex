import { describe, expect, it } from 'vitest';
import { paginateMcpItems } from '../../src/mcp/shared/response-limits.js';

describe('paginateMcpItems cursor validation', () => {
  it.each([
    'gn-page-v1:0:0',
    'gn-page-v1:11:0',
    'gn-page-v1:9007199254740992:0',
    'gn-page-v1:10:9007199254740992',
    'gn-page-v1:10:-1',
    'gn-page-v1:' + '9'.repeat(100000) + ':0',
  ])('rejects invalid cursors with a bounded message', (cursor) => {
    expect(() => paginateMcpItems([1, 2, 3], { pageSize: 10, cursor })).toThrow('Invalid cursor.');
  });

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid owner page sizes',
    (pageSize) => {
      expect(() => paginateMcpItems([1], { pageSize })).toThrow('Invalid page size.');
    },
  );

  it('keeps ordinary cursors and smaller page sizes compatible', () => {
    const first = paginateMcpItems([1, 2, 3], { pageSize: 2 });
    expect(first.items).toEqual([1, 2]);
    expect(paginateMcpItems([1, 2, 3], { pageSize: 2, cursor: first.page.next }).items).toEqual([
      3,
    ]);
    expect(paginateMcpItems([1, 2, 3], { pageSize: 2, cursor: 'gn-page-v1:1:0' }).items).toEqual([
      1,
    ]);
  });
});
