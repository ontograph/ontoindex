import { describe, expect, it, vi } from 'vitest';
import {
  retainableByFile,
  shouldRetainRegistration,
} from '../../src/core/ingestion/pipeline-phases/scope-retention-registration-filter.js';

describe('scope retention file filter', () => {
  const filePathOf = (item: { filePath?: unknown }) => item.filePath;
  const hasScopeHook = (filePath: string) => filePath.endsWith('.ts');

  it('returns the same array when nothing is dropped', () => {
    const items = [{ filePath: 'a.ts' }, { filePath: 'b.ts' }];
    expect(retainableByFile(items, filePathOf, hasScopeHook)).toBe(items);
  });

  it('filters unsupported files while preserving order and the input', () => {
    const first = Object.freeze({ filePath: 'first.ts' });
    const second = Object.freeze({ filePath: 'second.ts' });
    const items = Object.freeze([
      first,
      Object.freeze({ filePath: 'a.rs' }),
      Object.freeze({ filePath: 'b.py' }),
      second,
    ]);
    const retained = retainableByFile(items, filePathOf, hasScopeHook);
    expect(retained).toEqual([first, second]);
    expect(retained[0]).toBe(first);
    expect(retained[1]).toBe(second);
    expect(retained).not.toBe(items);
    expect(items.map(filePathOf)).toEqual(['first.ts', 'a.rs', 'b.py', 'second.ts']);
  });

  it('keeps non-string file paths for stage validation without consulting the provider', () => {
    const items = [{}, { filePath: null }, { filePath: 42 }, { filePath: false }];
    const predicate = vi.fn(() => false);
    expect(retainableByFile(items, filePathOf, predicate)).toBe(items);
    expect(predicate).not.toHaveBeenCalled();
  });

  it('returns the same empty array without consulting the provider', () => {
    const items: readonly { filePath: string }[] = [];
    const predicate = vi.fn(() => false);
    expect(retainableByFile(items, filePathOf, predicate)).toBe(items);
    expect(predicate).not.toHaveBeenCalled();
  });

  it('returns an empty array when every file is unsupported', () => {
    expect(
      retainableByFile([{ filePath: 'a.rs' }, { filePath: 'b.py' }], filePathOf, hasScopeHook),
    ).toEqual([]);
  });
});

describe('scope retention registration filter', () => {
  it.each(['a.rs', 'b.py'])('skips unsupported symbol registrations for %s', (filePath) => {
    const hasScopeHook = vi.fn(() => false);
    expect(
      shouldRetainRegistration(JSON.stringify({ kind: 'symbol.add', filePath }), hasScopeHook),
    ).toBe(false);
    expect(hasScopeHook).toHaveBeenCalledWith(filePath);
  });

  it('retains supported symbol registrations', () => {
    const hasScopeHook = vi.fn(() => true);
    expect(
      shouldRetainRegistration(
        JSON.stringify({ kind: 'symbol.add', filePath: 'c.ts' }),
        hasScopeHook,
      ),
    ).toBe(true);
    expect(hasScopeHook).toHaveBeenCalledWith('c.ts');
  });

  it.each(['type.registerClass', 'type.registerImpl', 'method.register', 'field.register'])(
    'uses def.filePath for %s',
    (kind) => {
      const hasScopeHook = vi.fn((filePath: string) => filePath === 'c.ts');
      expect(
        shouldRetainRegistration(JSON.stringify({ kind, def: { filePath: 'a.rs' } }), hasScopeHook),
      ).toBe(false);
      expect(
        shouldRetainRegistration(JSON.stringify({ kind, def: { filePath: 'c.ts' } }), hasScopeHook),
      ).toBe(true);
      expect(hasScopeHook.mock.calls).toEqual([['a.rs'], ['c.ts']]);
    },
  );

  it.each(['type.clear', 'method.clear', 'field.clear', 'model.clear'])(
    'retains %s without checking a file',
    (kind) => {
      const hasScopeHook = vi.fn(() => false);
      expect(shouldRetainRegistration(JSON.stringify({ kind }), hasScopeHook)).toBe(true);
      expect(hasScopeHook).not.toHaveBeenCalled();
    },
  );

  it.each([
    '{',
    'null',
    'false',
    '42',
    '"text"',
    '[]',
    '{}',
    '{"kind":"unknown","filePath":"a.rs"}',
    '{"kind":"symbol.add"}',
    '{"kind":"symbol.add","filePath":42}',
    '{"kind":"type.registerClass"}',
    '{"kind":"type.registerImpl","def":null}',
    '{"kind":"method.register","def":[]}',
    '{"kind":"method.register","def":{}}',
    '{"kind":"field.register","def":{"filePath":false}}',
  ])('leaves malformed or unexpected event %s for stage validation', (encoded) => {
    const hasScopeHook = vi.fn(() => false);
    expect(shouldRetainRegistration(encoded, hasScopeHook)).toBe(true);
    expect(hasScopeHook).not.toHaveBeenCalled();
  });
});
