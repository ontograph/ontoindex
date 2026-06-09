import { describe, it, expect } from 'vitest';
import { createWorkspacePackageStrategy } from '../../src/core/ingestion/import-resolvers/workspace-package.js';
import type { ResolveCtx } from '../../src/core/ingestion/import-resolvers/types.js';

// Minimal stub — the workspace-package strategy ignores filePath and ctx entirely.
const stubCtx = {} as ResolveCtx;

describe('workspace-package resolver', () => {
  const strategy = createWorkspacePackageStrategy({
    'ontoindex-shared': 'ontoindex-shared/src/index.ts',
  });

  it('maps a registered bare package name to the configured source path', () => {
    const result = strategy('ontoindex-shared', 'some/file.ts', stubCtx);
    expect(result).toEqual({ kind: 'files', files: ['ontoindex-shared/src/index.ts'] });
  });

  it('returns null for unregistered package names', () => {
    expect(strategy('some-other-pkg', 'some/file.ts', stubCtx)).toBeNull();
  });

  it('returns null for relative imports (dot-slash)', () => {
    expect(strategy('./local', 'some/file.ts', stubCtx)).toBeNull();
  });

  it('returns null for relative imports (double-dot)', () => {
    expect(strategy('../sibling', 'some/file.ts', stubCtx)).toBeNull();
  });

  it('handles an empty package map gracefully', () => {
    const emptyStrategy = createWorkspacePackageStrategy({});
    expect(emptyStrategy('ontoindex-shared', 'some/file.ts', stubCtx)).toBeNull();
  });

  it('resolves sub-path imports only when exact key matches', () => {
    // 'ontoindex-shared/utils' is NOT a key in the map — must return null.
    expect(strategy('ontoindex-shared/utils', 'some/file.ts', stubCtx)).toBeNull();
  });
});
