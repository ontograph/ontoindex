/**
 * Query rewrite — expand identifier-like tokens with case/separator variants for FTS recall.
 *
 * KuzuDB FTS uses Porter stemmer and does NOT split camelCase, snake_case, or
 * kebab-case identifiers. So `getUserData` is one indexed token and the query
 * "user data" cannot match it. This helper expands the query string by appending
 * split variants of each token while preserving the original tokens — purely
 * additive. Combined with `conjunctive := false` (OR semantics), this monotonically
 * widens recall without affecting exact-match precision.
 *
 * Examples:
 *   "mergeWithRRF"   → "mergeWithRRF merge With RRF"
 *   "pool_adapter"   → "pool_adapter pool adapter"
 *   "user-data"      → "user-data user data"
 *   "merge with rrf" → "merge with rrf"   (no identifier-shaped tokens)
 *   "URLParser"      → "URLParser URL Parser"
 */

export function expandQueryTokens(query: string): string {
  if (!query || typeof query !== 'string') return query;
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return query;
  const expanded: string[] = [];
  for (const token of tokens) {
    expanded.push(token);
    const split = splitIdentifier(token);
    if (split !== null) expanded.push(split);
  }
  return expanded.join(' ');
}

/**
 * Return a space-separated split of an identifier-shaped token, or null if the
 * token has no identifier-shape signal (no underscores, no hyphens, no
 * camelCase humps).
 */
function splitIdentifier(token: string): string | null {
  if (token.includes('_')) {
    const parts = token.split('_').filter(Boolean);
    if (parts.length > 1) return parts.join(' ');
  }
  if (token.includes('-')) {
    const parts = token.split('-').filter(Boolean);
    if (parts.length > 1) return parts.join(' ');
  }
  // camelCase / PascalCase / acronym-prefix (URLParser → URL Parser)
  if (/[a-z][A-Z]/.test(token) || /[A-Z]{2,}[a-z]/.test(token)) {
    return token.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z\d])([A-Z])/g, '$1 $2');
  }
  return null;
}
