/**
 * TypeScript / JavaScript / Vue import resolution configs.
 * All use standard resolution — TS/JS with tsconfig path aliases,
 * Vue delegates to TypeScript's resolver.
 *
 * Strategy order matters: standard resolver runs first (handles relative
 * imports and tsconfig aliases); workspace-package resolver runs second
 * and catches bare monorepo-sibling package names that have no tsconfig alias.
 */

import { SupportedLanguages } from 'ontoindex-shared';
import type { ImportResolutionConfig } from '../types.js';
import { createStandardStrategy } from '../standard.js';
import { createWorkspacePackageStrategy } from '../workspace-package.js';

/**
 * Bare package names that are workspace siblings in this monorepo but are
 * NOT listed in any tsconfig `paths` alias. The standard resolver cannot
 * reach them; the workspace-package strategy bridges the gap.
 *
 * Keys   — the exact string used in import statements (e.g. `'ontoindex-shared'`)
 * Values — repo-relative path to the package's source entry point
 */
const WORKSPACE_PACKAGES: Record<string, string> = {
  'ontoindex-shared': 'ontoindex-shared/src/index.ts',
};

const workspacePackageStrategy = createWorkspacePackageStrategy(WORKSPACE_PACKAGES);

export const typescriptImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.TypeScript,
  strategies: [createStandardStrategy(SupportedLanguages.TypeScript), workspacePackageStrategy],
};

export const javascriptImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.JavaScript,
  strategies: [createStandardStrategy(SupportedLanguages.JavaScript), workspacePackageStrategy],
};

// Vue SFCs are preprocessed into TypeScript upstream of import resolution,
// so the resolver intentionally runs as TypeScript. `language: Vue` here is
// documentation-only metadata (see `ImportResolutionConfig.language` JSDoc
// and ARCHITECTURE.md §Vue); it is not consumed by `createImportResolver`.
export const vueImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Vue,
  strategies: [createStandardStrategy(SupportedLanguages.TypeScript)],
};
