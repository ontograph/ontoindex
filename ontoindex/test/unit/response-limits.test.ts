import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { paginateMcpItems } from '../../src/mcp/shared/response-limits.js';

describe('paginateMcpItems cursor validation', () => {
  it('marks changed bound and legacy cursors as non-retryable restart errors', () => {
    const first = paginateMcpItems([1, 2], { pageSize: 1, binding: 'a' });
    for (const cursor of [first.page.next, 'gn-page-v1:1:1']) {
      try {
        paginateMcpItems([1, 2], { pageSize: 1, binding: 'b', cursor });
        throw new Error('expected restart');
      } catch (error) {
        expect(error).toMatchObject({ code: 'restart_required', retryable: false });
      }
    }
  });
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

  it('continues bound cursors for an unchanged dataset and request', () => {
    const items = ['alpha', 'beta', 'gamma'];
    const binding = JSON.stringify({ repo: 'repo-a', action: 'trace', filter: 'open', items });
    const digest = createHash('sha256').update(binding).digest('hex');
    const first = paginateMcpItems(items, { pageSize: 2, binding });

    expect(first.page.current).toBe(`gn-page-v2:2:0:${digest}`);
    expect(first.page.next).toBe(`gn-page-v2:2:2:${digest}`);
    expect(paginateMcpItems(items, { pageSize: 2, binding, cursor: first.page.next })).toEqual({
      items: ['gamma'],
      page: {
        current: `gn-page-v2:2:2:${digest}`,
        pageSize: 2,
        offset: 2,
        returned: 1,
        total: 3,
        hasMore: false,
      },
    });
  });

  it.each([
    ['reordered dataset', ['beta', 'alpha', 'gamma']],
    ['replaced content', ['alpha', 'replacement', 'gamma']],
  ])('rejects a bound cursor after %s with the same item count', (_description, changedItems) => {
    const items = ['alpha', 'beta', 'gamma'];
    const first = paginateMcpItems(items, { pageSize: 2, binding: JSON.stringify(items) });

    expect(() =>
      paginateMcpItems(changedItems, {
        pageSize: 2,
        binding: JSON.stringify(changedItems),
        cursor: first.page.next,
      }),
    ).toThrow('Cursor no longer matches this dataset; restart pagination.');
  });

  it.each([
    { repo: 'repo-b', action: 'trace', filter: 'open' },
    { repo: 'repo-a', action: 'context', filter: 'open' },
    { repo: 'repo-a', action: 'trace', filter: 'closed' },
  ])('rejects a bound cursor when request identity changes: %j', (changedRequest) => {
    const items = [1, 2, 3];
    const request = { repo: 'repo-a', action: 'trace', filter: 'open' };
    const first = paginateMcpItems(items, {
      pageSize: 2,
      binding: JSON.stringify({ ...request, items }),
    });

    expect(() =>
      paginateMcpItems(items, {
        pageSize: 2,
        binding: JSON.stringify({ ...changedRequest, items }),
        cursor: first.page.next,
      }),
    ).toThrow('Cursor no longer matches this dataset; restart pagination.');
  });

  it('requires a restart for legacy cursors when a binding is supplied', () => {
    expect(() =>
      paginateMcpItems([1, 2, 3], {
        pageSize: 2,
        binding: '',
        cursor: 'gn-page-v1:2:2',
      }),
    ).toThrow('Cursor no longer matches this dataset; restart pagination.');
  });

  it('rejects bound cursors when no binding is supplied', () => {
    const first = paginateMcpItems([1, 2, 3], { pageSize: 2, binding: 'dataset' });
    expect(() => paginateMcpItems([1, 2, 3], { pageSize: 2, cursor: first.page.next })).toThrow(
      'Invalid cursor.',
    );
  });

  it.each([
    'gn-page-v2:0:0:' + 'a'.repeat(64),
    'gn-page-v2:11:0:' + 'a'.repeat(64),
    'gn-page-v2:9007199254740992:0:' + 'a'.repeat(64),
    'gn-page-v2:10:9007199254740992:' + 'a'.repeat(64),
    'gn-page-v2:10:-1:' + 'a'.repeat(64),
    'gn-page-v2:10:0:' + 'a'.repeat(63),
    'gn-page-v2:10:0:' + 'g'.repeat(64),
    'gn-page-v2:10:0:' + 'a'.repeat(100000),
  ])('rejects malformed or oversized bound cursors with a bounded message', (cursor) => {
    expect(() => paginateMcpItems([1, 2, 3], { pageSize: 10, binding: 'dataset', cursor })).toThrow(
      'Invalid cursor.',
    );
  });
});
