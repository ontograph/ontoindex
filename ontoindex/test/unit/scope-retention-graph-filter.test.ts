import { describe, expect, it } from 'vitest';
import { createGraphRetentionFilter } from '../../src/core/ingestion/pipeline-phases/scope-retention-registration-filter.js';

const node = (id: string, filePath: unknown) => ({
  id,
  label: 'Function',
  properties: { name: id, filePath },
});

describe('graph retention filter', () => {
  const isRefused = (filePath: string) => filePath.endsWith('.rs');

  it('drops refused-file nodes and every edge touching them', () => {
    const filter = createGraphRetentionFilter(isRefused);
    expect(filter.retainNode(node('a', 'a.ts'))).toBe(true);
    expect(filter.retainNode(node('r', 'lib.rs'))).toBe(false);
    expect(filter.retainRelationship({ sourceId: 'a', targetId: 'a' })).toBe(true);
    expect(filter.retainRelationship({ sourceId: 'r', targetId: 'a' })).toBe(false);
    expect(filter.retainRelationship({ sourceId: 'a', targetId: 'r' })).toBe(false);
  });

  it('drops Section nodes and every edge touching them while keeping other nodes in the same file', () => {
    const filter = createGraphRetentionFilter(isRefused);
    expect(filter.retainNode({ ...node('s', 'README.md'), label: 'Section' })).toBe(false);
    expect(filter.retainNode(node('a', 'README.md'))).toBe(true);
    expect(filter.retainRelationship({ sourceId: 's', targetId: 'a' })).toBe(false);
    expect(filter.retainRelationship({ sourceId: 'a', targetId: 's' })).toBe(false);
    expect(filter.retainRelationship({ sourceId: 'a', targetId: 'a' })).toBe(true);
  });

  it('keeps Section nodes without a string id for stage validation', () => {
    const filter = createGraphRetentionFilter(() => true);
    for (const id of [undefined, null, 3]) {
      expect(
        filter.retainNode({ id, label: 'Section', properties: { filePath: 'README.md' } }),
      ).toBe(true);
    }
  });

  it('keeps nodes without a usable file path and malformed values for stage validation', () => {
    const filter = createGraphRetentionFilter(() => true);
    for (const value of [
      node('x', undefined),
      node('y', 7),
      { id: 3, properties: { filePath: 'a.rs' } },
      null,
      'text',
    ]) {
      expect(filter.retainNode(value)).toBe(true);
    }
    expect(filter.retainRelationship(null)).toBe(true);
    expect(filter.retainRelationship({ sourceId: 1, targetId: 2 })).toBe(true);
  });
});
