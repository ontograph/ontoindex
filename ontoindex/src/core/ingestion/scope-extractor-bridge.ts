/**
 * Bridge between a language provider's `emitScopeCaptures` hook and the
 * `ScopeExtractor` (RFC #909 Ring 2 PKG #920).
 *
 * Extracted into its own module so it can be imported by test code
 * without pulling in `parse-worker.ts` — which has a top-level
 * `parentPort!.on('message', ...)` call that assumes a worker-thread
 * context and throws on direct import.
 *
 * The bridge:
 *
 *   1. Short-circuits when the provider has NOT implemented
 *      `emitScopeCaptures`. Reports an unsupported outcome; zero work done.
 *   2. Invokes the hook + feeds its output to `ScopeExtractor.extract`.
 *   3. **Catches exceptions from either side.** A failure reports a failed
 *      outcome, distinguishing unsupported syntax, and emits a warning via
 *      `onWarn`, except for an expected C++ missing-module miss.
 *      Exceptions from `onWarn` still propagate.
 *      The compatibility wrapper returns `undefined` for either miss.
 *      Scope-based resolution is the new path under construction — it
 *      must not destabilize the legacy DAG.
 */

import type { ParsedFile } from 'ontoindex-shared';
import { extract as extractScope } from './scope-extractor.js';
import { isScopeUnsupportedSyntax } from './scope-unsupported-syntax.js';
import type { LanguageProvider } from './language-provider.js';
import type { SyntaxNode } from './utils/ast-helpers.js';

/** Callback used to report scope-extraction warnings to the host (worker or direct). */
type ScopeBridgeWarn = (message: string) => void;

export type ScopeExtractionOutcome =
  | { status: 'success'; parsedFile: ParsedFile }
  | { status: 'unsupported'; reason: 'missing-scope-hook' }
  | {
      status: 'failed';
      reason: 'scope-extraction-error' | 'missing-module-scope' | 'unsupported-syntax';
    };

/** Compact evidence for attempted extraction; absent records do not establish completeness. */
export type ScopeExtractionRecord = { filePath: string } & (
  | { status: 'success' }
  | { status: 'unsupported'; reason: 'missing-scope-hook' }
  | {
      status: 'failed';
      reason: 'scope-extraction-error' | 'missing-module-scope' | 'unsupported-syntax';
    }
);

const NO_MODULE_SCOPE_MESSAGE = 'ScopeExtractor: no Module scope found';
const CPP_LIKE_EXTENSIONS = new Set(['.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.hh']);

/**
 * Produce a `ParsedFile` for the given file, or `undefined` when the
 * provider hasn't migrated / the extractor throws. Exceptions from the
 * warning callback still propagate.
 */
export function extractParsedFile(
  provider: LanguageProvider,
  sourceText: string,
  filePath: string,
  onWarn?: ScopeBridgeWarn,
  rootNode?: SyntaxNode,
): ParsedFile | undefined {
  const outcome = extractParsedFileOutcome(provider, sourceText, filePath, onWarn, rootNode);
  return outcome.status === 'success' ? outcome.parsedFile : undefined;
}

/** Report scope extraction status while preserving warning callback exceptions. */
export function extractParsedFileOutcome(
  provider: LanguageProvider,
  sourceText: string,
  filePath: string,
  onWarn?: ScopeBridgeWarn,
  rootNode?: SyntaxNode,
): ScopeExtractionOutcome {
  if (provider.emitScopeCaptures === undefined) {
    return { status: 'unsupported', reason: 'missing-scope-hook' };
  }
  try {
    const captures =
      rootNode === undefined
        ? provider.emitScopeCaptures(sourceText, filePath)
        : provider.emitScopeCaptures(sourceText, filePath, rootNode);
    return { status: 'success', parsedFile: extractScope(captures, filePath, provider) };
  } catch (err) {
    if (isExpectedCppNoModuleScopeMiss(err, filePath)) {
      return { status: 'failed', reason: 'missing-module-scope' };
    }

    const message = `scope extraction failed for ${filePath}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    if (onWarn !== undefined) onWarn(message);
    else console.warn(message);
    if (isScopeUnsupportedSyntax(err)) {
      return { status: 'failed', reason: 'unsupported-syntax' };
    }
    return { status: 'failed', reason: 'scope-extraction-error' };
  }
}

function isExpectedCppNoModuleScopeMiss(err: unknown, filePath: string): boolean {
  if (!(err instanceof Error) || !err.message.startsWith(NO_MODULE_SCOPE_MESSAGE)) {
    return false;
  }
  return CPP_LIKE_EXTENSIONS.has(extensionOf(filePath));
}

function extensionOf(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const basename = filePath.slice(lastSlash + 1);
  const lastDot = basename.lastIndexOf('.');
  return lastDot === -1 ? '' : basename.slice(lastDot).toLowerCase();
}
