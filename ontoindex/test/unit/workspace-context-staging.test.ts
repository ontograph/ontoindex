import { describe, expect, it } from 'vitest';

import {
  createStagedContext,
  type StagedContextEntry,
  type StagedContextEntryKind,
} from '../../src/core/workspace/context-staging.js';

describe('createStagedContext', () => {
  it('orders staged entries deterministically by kind, identity, and insertion order', () => {
    const entries: StagedContextEntry[] = [
      { kind: 'note', id: 'z-note', title: 'Third note', content: 'N3' },
      { kind: 'file', id: 'z-file', title: 'file', content: 'alpha' },
      { kind: 'symbol', id: 'sym-two', title: 'Symbol', content: 'b' },
      { kind: 'file', id: 'a-file', title: 'file', content: 'beta' },
      { kind: 'symbol', id: 'sym-one', title: 'Symbol', content: 'a' },
      { kind: 'process', id: 'p', title: 'proc', content: 'p' },
    ];

    const { entries: sorted } = createStagedContext({ entries });

    expect(sorted.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      'symbol:sym-one',
      'symbol:sym-two',
      'file:a-file',
      'file:z-file',
      'process:p',
      'note:z-note',
    ]);
  });

  it('deduplicates by stable identity and keeps first occurrence', () => {
    const entries: StagedContextEntry[] = [
      { kind: 'symbol', id: 'dup-id', title: 'first', content: 'one' },
      { kind: 'symbol', id: 'dup-id', title: 'second', content: 'two' },
      { kind: 'file', graphUid: 'graph-uid', title: 'one', content: 'one' },
      { kind: 'process', graphUid: 'process-uid', title: 'two', content: 'two' },
      {
        kind: 'file',
        filePath: '/repo/source.ts',
        lineSpan: { start: 10, end: 12 },
        title: 'a',
        content: 'a',
      },
      {
        kind: 'file',
        filePath: '/repo/source.ts',
        lineSpan: { start: 10, end: 12 },
        title: 'b',
        content: 'b',
      },
      {
        kind: 'note',
        title: 'same fallback',
        content: 'same',
      },
      {
        kind: 'note',
        title: 'same fallback',
        content: 'same',
      },
    ];

    const result = createStagedContext({ entries });

    expect(result.entries).toHaveLength(5);
    expect(result.entries).toEqual([
      {
        kind: 'symbol',
        id: 'dup-id',
        title: 'first',
        content: 'one',
      },
      {
        kind: 'file',
        filePath: '/repo/source.ts',
        lineSpan: { start: 10, end: 12 },
        title: 'a',
        content: 'a',
      },
      {
        kind: 'file',
        graphUid: 'graph-uid',
        title: 'one',
        content: 'one',
      },
      {
        kind: 'process',
        graphUid: 'process-uid',
        title: 'two',
        content: 'two',
      },
      {
        kind: 'note',
        title: 'same fallback',
        content: 'same',
      },
    ]);
  });

  it('adds deterministic truncation warnings when maxEntries is exceeded', () => {
    const entries = [
      { kind: 'symbol' as const, id: 'a', title: 'a', content: 'a' },
      { kind: 'symbol' as const, id: 'b', title: 'b', content: 'b' },
      { kind: 'symbol' as const, id: 'c', title: 'c', content: 'c' },
    ];

    const result = createStagedContext({
      entries,
      limits: { maxEntries: 2 },
    });

    expect(result.entries).toHaveLength(2);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'staged-context-max-entries',
          truncatedCount: 1,
          maxEntries: 2,
        }),
      ]),
    );
  });

  it('adds deterministic truncation warnings when maxEstimatedBytes is exceeded', () => {
    const entries: StagedContextEntry[] = [
      {
        kind: 'note',
        title: 'big',
        content: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      },
      {
        kind: 'note',
        title: 'small',
        content: 'y',
      },
    ];

    const result = createStagedContext({
      entries,
      limits: { maxEstimatedBytes: 1 },
    });

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'staged-context-max-estimated-bytes',
          truncatedCount: 2,
          maxEstimatedBytes: 1,
        }),
      ]),
    );
  });

  it('preserves provenance fields through staging', () => {
    const entries: StagedContextEntry[] = [
      {
        kind: 'file',
        title: 'staged file',
        content: 'payload',
        sourceTool: 'test-generator',
        graphUid: 'g-123',
        filePath: 'src/index.ts',
        lineSpan: { start: 1, end: 15 },
        confidence: 0.88,
      },
    ];

    const { entries: resultEntries } = createStagedContext({ entries });

    expect(resultEntries[0]).toMatchObject({
      sourceTool: 'test-generator',
      graphUid: 'g-123',
      filePath: 'src/index.ts',
      lineSpan: { start: 1, end: 15 },
      confidence: 0.88,
    });
  });

  it('does not mutate supplied entries array', () => {
    const sourceEntries = [
      {
        kind: 'symbol' as StagedContextEntryKind,
        id: 'x',
        title: 'mutable',
        content: 'content',
        lineSpan: { start: 3 },
      },
    ] as const;

    const entriesCopy = structuredClone(sourceEntries);
    createStagedContext({ entries: sourceEntries });

    expect(sourceEntries).toEqual(entriesCopy);
  });
});
