/**
 * Cypher predicates that match `CodeRelation.type` against a set of types.
 *
 * LadybugDB 0.17.1 returns wrong rows for `r.type IN [...]` and
 * `r.type IN $types` after a bulk COPY when the other endpoint is unlabeled:
 * it drops some matches and repeats others. An OR chain of `=` comparisons
 * returns the correct rows. Reproduction: scripts/repro/ladybug-rel-type-in.mjs.
 * Remove this workaround once a fixed @ladybugdb/core release ships.
 *
 * test/unit/relation-type-in-guard.test.ts fails on new `.type IN` uses in src/.
 */

const RELATION_TYPE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function uniqueTypes(types: readonly string[]): string[] {
  return [...new Set(types)];
}

/**
 * Inline predicate for trusted relation-type constants, such as
 * `(r.type = 'CALLS' OR r.type = 'IMPORTS')`. Throws on anything that is not
 * an upper-case identifier, so it never splices caller-controlled text.
 */
export function relationTypePredicate(alias: string, types: readonly string[]): string {
  const unique = uniqueTypes(types);
  if (unique.length === 0) throw new Error('relationTypePredicate requires at least one type');
  for (const t of unique) {
    if (!RELATION_TYPE_PATTERN.test(t)) throw new Error(`Invalid relation type: ${t}`);
  }
  const clauses = unique.map((t) => `${alias}.type = '${t}'`);
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`;
}

/**
 * Parameterized predicate for caller-supplied relation types. Returns the
 * predicate text and the parameters to merge into the query parameters:
 * `(r.type = $relType0 OR r.type = $relType1)`.
 */
export function relationTypeParamPredicate(
  alias: string,
  types: readonly string[],
  paramPrefix = 'relType',
): { predicate: string; params: Record<string, string> } {
  const unique = uniqueTypes(types);
  if (unique.length === 0) {
    throw new Error('relationTypeParamPredicate requires at least one type');
  }
  const params: Record<string, string> = {};
  const clauses = unique.map((t, i) => {
    params[`${paramPrefix}${i}`] = t;
    return `${alias}.type = $${paramPrefix}${i}`;
  });
  return {
    predicate: clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`,
    params,
  };
}
