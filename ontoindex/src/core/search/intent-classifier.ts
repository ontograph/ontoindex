/**
 * Intent classifier — regex/keyword-based query → intent mapping.
 *
 * Maps a natural-language query to one of four intent classes used by the
 * v6 retrieval pipeline:
 *
 *   - `calls-of`           — "what calls X", "callers of X" (caller lookup)
 *   - `cross-file-impact`  — "what breaks if X changes", "downstream of X"
 *   - `nl-conceptual`      — "how does X work", "where is X" (conceptual)
 *   - `ambiguous`          — short bare-token queries with no class signal
 *
 * Keyword arrays are sourced from `ontoindex/src/mcp/local/backend-route.ts`
 * (`routeTool()`) per Pre-Phase-0 Audit 3 recommendation #1-2. They are
 * duplicated here rather than extracted into a shared constant — `backend-route.ts`
 * is preserved as-is per CLAUDE.md § Code change discipline. If the lists
 * drift in the future, reconcile them as a separate cleanup bundle.
 *
 * Decision: heuristic rules (option b) over LLM pass (option a) — per v6 plan
 * W1a. Validated against 74 already-labeled queries (training=30 + heldout=34
 * + pilot=10). See `test/unit/intent-classifier.test.ts` for accuracy gate.
 */

export type Intent = 'calls-of' | 'cross-file-impact' | 'nl-conceptual' | 'ambiguous';

export interface IntentClassification {
  intent: Intent;
  confidence: number;
  matchedKeywords: string[];
}

const CALLS_OF_KEYWORDS = [
  'what calls',
  'who calls',
  'callers of',
  'who invokes',
  'invokes',
  'invocations of',
] as const;

const CROSS_FILE_IMPACT_KEYWORDS = [
  'what breaks',
  'safe to change',
  'breaks if',
  'impact of',
  'downstream',
  'depends on',
  'affected by',
  'consumers of',
  'reverse dep',
  'files affected',
] as const;

const NL_CONCEPTUAL_KEYWORDS = [
  'how does',
  'how do ',
  'how works',
  'how is ',
  'how are ',
  'architecture',
  'explain',
  'where is',
  'where does',
  'what is the',
  'what runs',
  'walk me through',
] as const;

const AMBIGUOUS_TOKEN_LIMIT = 2;

export function classifyIntent(query: string): IntentClassification {
  if (!query || typeof query !== 'string') {
    return { intent: 'ambiguous', confidence: 0, matchedKeywords: [] };
  }
  const q = query.toLowerCase().trim();
  if (!q) {
    return { intent: 'ambiguous', confidence: 0, matchedKeywords: [] };
  }

  // Priority order: most specific class first. The `cross-file-impact` keyword
  // 'what breaks' contains 'what' which would otherwise also pull into a future
  // `what is`-style nl-conceptual rule. Keep impact checked before conceptual.
  const callsMatches = CALLS_OF_KEYWORDS.filter((k) => q.includes(k));
  if (callsMatches.length > 0) {
    return { intent: 'calls-of', confidence: 0.9, matchedKeywords: [...callsMatches] };
  }

  const impactMatches = CROSS_FILE_IMPACT_KEYWORDS.filter((k) => q.includes(k));
  if (impactMatches.length > 0) {
    return { intent: 'cross-file-impact', confidence: 0.85, matchedKeywords: [...impactMatches] };
  }

  const conceptualMatches = NL_CONCEPTUAL_KEYWORDS.filter((k) => q.includes(k));
  if (conceptualMatches.length > 0) {
    return { intent: 'nl-conceptual', confidence: 0.8, matchedKeywords: [...conceptualMatches] };
  }

  // Ambiguity: ≤ N tokens with no class signal (single-word "analyze", "wiki").
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length <= AMBIGUOUS_TOKEN_LIMIT) {
    return { intent: 'ambiguous', confidence: 0.7, matchedKeywords: [] };
  }

  // Fallback: longer queries with no keyword signal are most likely conceptual
  // ("describe the wiki cache flow"). Low confidence so consumers can decide
  // whether to apply intent-conditioned policies.
  return { intent: 'nl-conceptual', confidence: 0.5, matchedKeywords: [] };
}
