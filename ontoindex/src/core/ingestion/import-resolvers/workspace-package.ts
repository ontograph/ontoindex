/**
 * Workspace-package import resolution strategy.
 *
 * Maps bare imports of workspace-sibling packages (e.g. `ontoindex-shared`)
 * to a source-file path relative to the indexed repo root. The standard
 * resolver only handles tsconfig `paths` aliases — this strategy covers
 * monorepo-style packages that are not listed there.
 *
 * Configuration is a simple name → repo-relative source-entry map. For
 * the current OntoIndex repo, that is
 * `{ 'ontoindex-shared': 'ontoindex-shared/src/index.ts' }`.
 * The map is passed in at resolver-construction time so the list is
 * defined in the language config rather than hardcoded here.
 *
 * Iteration model: strategies are tried in order by `createImportResolver`;
 * the first non-null result wins. This strategy must be placed AFTER the
 * standard strategy so tsconfig aliases take priority.
 */

import type { ImportResolverStrategy, ImportResult, ResolveCtx } from './types.js';

/**
 * Create a workspace-package resolution strategy.
 *
 * @param packageMap - Maps bare package names to repo-relative source entry paths.
 *   Example: `{ 'ontoindex-shared': 'ontoindex-shared/src/index.ts' }`
 */
export function createWorkspacePackageStrategy(
  packageMap: Readonly<Record<string, string>>,
): ImportResolverStrategy {
  return (rawImportPath: string, _filePath: string, _ctx: ResolveCtx): ImportResult => {
    // Only handle bare (non-relative) imports.
    if (rawImportPath.startsWith('.')) return null;

    const entry = packageMap[rawImportPath];
    if (!entry) return null;

    // Return as a single-file resolution. The entry is already repo-relative;
    // the main ingestion loop slots it into allFiles via the import map.
    return { kind: 'files', files: [entry] };
  };
}
