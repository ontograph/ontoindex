import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GraphIdentityCandidate } from '../../src/core/ingestion/enrichment/markdown-graph-identity-provider.js';
import {
  mentionLookupName,
  resolveMentionTexts,
} from '../../src/core/ingestion/enrichment/markdown-mention-resolution.js';

const candidate = (id: string): GraphIdentityCandidate => ({
  type: 'symbol',
  id,
  name: id,
  filePath: 'src/code.ts',
  startLine: 7,
  confidence: 0.9,
});

afterEach(() => vi.useRealTimers());

describe('Markdown mention resolution', () => {
  it('MR1-A: accepts only bounded symbol names', () => {
    for (const [text, name] of [
      ['foo', 'foo'],
      ['Foo.bar', 'bar'],
      ['$x', '$x'],
      [' foo ', 'foo'],
    ]) {
      expect(mentionLookupName(text!)).toBe(name);
    }
    for (const text of ['git status', 'src/a.ts', 'foo()', '--flag', 'a'.repeat(81), '`foo`', '']) {
      expect(mentionLookupName(text)).toBeUndefined();
    }
  });

  it('MR1-B: resolves code symbols but not File-like candidates', async () => {
    const findSymbols = vi
      .fn()
      .mockResolvedValueOnce([candidate('foo')])
      .mockResolvedValueOnce([{ type: 'file', id: 'File:bar', confidence: 0.9 }]);
    const { resolutions } = await resolveMentionTexts(['foo', 'bar'], { findSymbols });
    expect(resolutions.get('foo')).toEqual({
      status: 'resolved',
      targets: [{ id: 'foo', name: 'foo', filePath: 'src/code.ts', startLine: 7 }],
    });
    expect(resolutions.get('bar')).toEqual({ status: 'unresolved', targets: [] });
  });

  it('MR1-C: reports ambiguity with counts and no targets, including raw overflow', async () => {
    const findSymbols = vi
      .fn()
      .mockResolvedValueOnce([candidate('a'), candidate('b')])
      .mockResolvedValueOnce(['a', 'b', 'c', 'd'].map(candidate))
      .mockResolvedValueOnce([
        candidate('a'),
        ...['b', 'c', 'd'].map((id) => ({ type: 'file', id })),
      ]);
    const { resolutions } = await resolveMentionTexts(['two', 'four', 'mixed'], { findSymbols });
    expect(resolutions.get('two')).toEqual({
      status: 'ambiguous',
      targets: [],
      candidateCount: 2,
    });
    expect(resolutions.get('four')).toEqual({
      status: 'ambiguous',
      targets: [],
      candidateCount: 4,
    });
    expect(resolutions.get('mixed')).toEqual({
      status: 'ambiguous',
      targets: [],
      candidateCount: 1,
    });
  });

  it('MR1-D: caps distinct lookups and maps aliases to original texts', async () => {
    const findSymbols = vi.fn().mockResolvedValue([candidate('foo')]);
    const texts = Array.from({ length: 100 }, (_, index) => `name${index}`);
    const bounded = await resolveMentionTexts(texts, { findSymbols });
    expect(findSymbols).toHaveBeenCalledTimes(40);
    expect(bounded.summary).toEqual({ status: 'ok', lookups: 40 });
    expect(bounded.resolutions.has('name40')).toBe(false);
    expect(findSymbols.mock.calls.map(([query]) => query.mention)).toEqual(texts.slice(0, 40));
    findSymbols.mockClear();
    const aliases = await resolveMentionTexts(['foo', 'foo', 'Foo.foo', ' foo '], { findSymbols });
    expect(findSymbols).toHaveBeenCalledExactlyOnceWith({ mention: 'foo', maxCandidates: 4 });
    expect([...aliases.resolutions.keys()]).toEqual(['foo', 'Foo.foo', ' foo ']);
    expect((await resolveMentionTexts(['foo()'], { findSymbols })).summary).toEqual({
      status: 'ok',
      lookups: 0,
    });
  });

  it('MR1-E: continues after provider errors without throwing', async () => {
    const findSymbols = vi
      .fn()
      .mockResolvedValueOnce([candidate('before')])
      .mockImplementationOnce(() => {
        throw new Error('provider failed');
      })
      .mockResolvedValueOnce([candidate('after')]);
    const result = await resolveMentionTexts(['before', 'failed', 'after'], { findSymbols });
    expect(result.summary).toEqual({ status: 'partial', lookups: 3, reason: 'provider-error' });
    expect(result.resolutions.has('failed')).toBe(false);
    expect(result.resolutions.get('before')?.status).toBe('resolved');
    expect(result.resolutions.get('after')?.status).toBe('resolved');
  });

  it('MR1-F: bounds a never-resolving provider to the remaining deadline and clears timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const findSymbols = vi
      .fn()
      .mockResolvedValueOnce([candidate('fast')])
      .mockImplementationOnce(() => new Promise<GraphIdentityCandidate[]>(() => {}));
    const pending = resolveMentionTexts(
      ['fast', 'hung', 'later'],
      { findSymbols },
      { timeoutMs: 20 },
    );
    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    expect(result.summary).toEqual({ status: 'partial', lookups: 2, reason: 'timeout' });
    expect([...result.resolutions.keys()]).toEqual(['fast']);
    expect(findSymbols).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears successful lookup timers and stops before a zero-budget lookup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const findSymbols = vi.fn().mockResolvedValue([]);
    expect((await resolveMentionTexts(['foo'], { findSymbols })).summary.status).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
    findSymbols.mockClear();
    expect((await resolveMentionTexts(['foo'], { findSymbols }, { timeoutMs: 0 })).summary).toEqual(
      { status: 'partial', lookups: 0, reason: 'timeout' },
    );
    expect(findSymbols).not.toHaveBeenCalled();
  });
});
