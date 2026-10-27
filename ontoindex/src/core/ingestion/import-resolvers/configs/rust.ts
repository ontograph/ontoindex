/**
 * Rust import resolution config.
 * Rust module strategy (grouped imports, crate/super/self paths), then standard fallback.
 */

import { SupportedLanguages } from 'ontoindex-shared';
import type { ImportResolutionConfig, ImportResolverStrategy, ResolveCtx } from '../types.js';
import { createStandardStrategy } from '../standard.js';
import { resolveRustImportInternal } from '../rust.js';

/** Cargo-backed bare imports must not fall through to filename guessing. */
function resolveCargoRootImport(raw: string, filePath: string, ctx: ResolveCtx): string[] {
  const source = raw.trim();
  const brace = source.indexOf('{');
  if (brace !== -1) {
    // slim: one grouping level; nested groups need a structured use-tree resolver.
    if (!source.endsWith('}') || source.indexOf('{', brace + 1) !== -1) return [];
    const prefix = source.slice(0, brace);
    if (prefix && !prefix.endsWith('::')) return [];
    const items = source
      .slice(brace + 1, -1)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const resolved = items.map((item) => resolveCargoRootImport(prefix + item, filePath, ctx));
    // The binding owner cannot attribute unresolved group members to separate files.
    return resolved.some((files) => files.length === 0) ? [] : resolved.flat();
  }
  const importPath = source.replace(/\s+as\s+(?:r#)?[A-Za-z_][A-Za-z0-9_]*$/, '');
  if (/^(crate|self|super)::/.test(importPath)) {
    const resolved = resolveRustImportInternal(filePath, importPath, ctx.allFilePaths);
    return resolved ? [resolved] : [];
  }
  // Only a root module and its immediate item are proven by this evidence.
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:::(?:[A-Za-z_][A-Za-z0-9_]*|\*))?$/.exec(importPath);
  if (
    !match ||
    !ctx.configs.rustCrateRoots?.includes(filePath) ||
    !ctx.rustDeclaredModules?.includes(match[1])
  )
    return [];
  const slash = filePath.lastIndexOf('/');
  const base = (slash === -1 ? '' : filePath.slice(0, slash + 1)) + match[1];
  const candidates = [base + '.rs', base + '/mod.rs'].filter((p) => ctx.allFilePaths.has(p));
  return candidates.length === 1 ? candidates : [];
}

/** Rust module resolution strategy — handles grouped imports and crate/super/self paths. */
export const rustModuleStrategy: ImportResolverStrategy = (rawImportPath, filePath, ctx) => {
  if (
    ctx.configs.rustCrateRoots !== undefined &&
    (!/^(crate|self|super)::/.test(rawImportPath) || rawImportPath.includes('{'))
  ) {
    return {
      kind: 'files',
      files: [...new Set(resolveCargoRootImport(rawImportPath, filePath, ctx))],
    };
  }
  // Top-level grouped: use {crate::a, crate::b}
  if (rawImportPath.startsWith('{') && rawImportPath.endsWith('}')) {
    const inner = rawImportPath.slice(1, -1);
    const parts = inner
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const resolved: string[] = [];
    for (const part of parts) {
      const r = resolveRustImportInternal(filePath, part, ctx.allFilePaths);
      if (r) resolved.push(r);
    }
    return resolved.length > 0 ? { kind: 'files', files: resolved } : null;
  }

  // Scoped grouped: use crate::models::{User, Repo}
  const braceIdx = rawImportPath.indexOf('::{');
  if (braceIdx !== -1 && rawImportPath.endsWith('}')) {
    const pathPrefix = rawImportPath.substring(0, braceIdx);
    const braceContent = rawImportPath.substring(braceIdx + 3, rawImportPath.length - 1);
    const items = braceContent
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const resolved: string[] = [];
    for (const item of items) {
      // Handle `use crate::models::{User, Repo as R}` — strip alias for resolution
      const itemName = item.includes(' as ') ? item.split(' as ')[0].trim() : item;
      const r = resolveRustImportInternal(filePath, `${pathPrefix}::${itemName}`, ctx.allFilePaths);
      if (r) resolved.push(r);
    }
    if (resolved.length > 0) return { kind: 'files', files: resolved };
    // Fallback: resolve the prefix path itself (e.g. crate::models -> models.rs)
    const prefixResult = resolveRustImportInternal(filePath, pathPrefix, ctx.allFilePaths);
    if (prefixResult) return { kind: 'files', files: [prefixResult] };
  }

  return null;
};

export const rustImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Rust,
  strategies: [rustModuleStrategy, createStandardStrategy(SupportedLanguages.Rust)],
};
