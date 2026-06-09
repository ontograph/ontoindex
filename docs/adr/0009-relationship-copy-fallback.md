# ADR-0009: Relationship COPY fallback + 1000-edge guard

**Status:** Accepted
**Date:** 2026-04-30 (perf-stability)
**Source:** `ontoindex/src/core/lbug/lbug-adapter.ts`, `schema.ts`; test in `ontoindex/test/integration/lbug-edge-limit.test.ts`.

## Context

LadybugDB / KuzuDB uses bulk `COPY` for fast edge ingestion. COPY requires the relationship table's schema to define the (fromLabel, toLabel) pair. Edges with unknown label pairs (e.g., a future code path emits `Foo→Bar` but the schema only defines `Foo→Baz`) cause cryptic native errors. Pre-perf-stability code attempted COPY for every pair, fell back to per-edge INSERTs on failure — fine for a few errors, catastrophically slow when thousands of edges have a bad pair.

## Decision

**Preflight-check** every pair against parsed `RELATION_SCHEMA` before attempting COPY. Pairs not in the schema route directly to fallback. After all COPY attempts, if **`failedPairEdges > 1000`**, throw instead of attempting individual inserts (prevent runaway slowdown). Test the throw path with an integration test using a semantically-impossible label pair.

## Algorithm / Technique

### Schema parsing (`lbug-adapter.ts`)

```
function getValidRelPairs(): Set<string> {
  const pairs = new Set<string>();
  const regex = /FROM\s+(`?\w+`?)\s+TO\s+(`?\w+`?)/g;
  for (const match of RELATION_SCHEMA.matchAll(regex)) {
    const from = match[1].replace(/`/g, '');
    const to = match[2].replace(/`/g, '');
    pairs.add(`${from}|${to}`);
  }
  return pairs;
}

const validRelPairs = getValidRelPairs();  // module-load-time
```

`RELATION_SCHEMA` (in `schema.ts`) is a static template-literal const — parsed once at module import. Backtick-quoted labels (`` `Struct` ``, `` `Enum` ``) are stripped. The Set contains canonical `from|to` keys.

Verified via review: ~203 FROM/TO pairs in the schema — all parse correctly; the regex handles both bare and backtick-quoted labels.

### COPY loop with preflight (`loadGraphToLbug`)

```
let failedPairEdges = 0;

for (const [pairKey, edgeRows] of pairToEdges) {
  // Preflight: skip COPY if pair not in schema
  if (!validRelPairs.has(pairKey)) {
    failedPairEdges += edgeRows.length;
    continue;
  }

  // Attempt COPY
  try {
    await executeCopy(edgeRows, pairKey);
  } catch (copyErr) {
    failedPairEdges += edgeRows.length;
    // (don't fall through to individual inserts here — see guard below)
  }
}

if (failedPairEdges > 1000) {
  throw new Error(
    `loadGraphToLbug: ${failedPairEdges} edges failed COPY across ` +
    `${schemaCount} schema-skipped + ${copyCount} copy-failed pairs; ` +
    `exceeds 1000-edge limit, aborting fallback`,
  );
}

// Below 1000: per-edge individual inserts as last resort
```

`pairKey = "${fromLabel}|${toLabel}"` is constructed identically to the Set entries — exact match.

### Why the 1000-edge guard

- Below 1000: per-edge inserts are slow but tolerable (a few seconds).
- Above 1000: per-edge inserts can take minutes, freezing the analyze pipeline.
- The guard surfaces the schema mismatch as an error instead of a silent slowdown — operators can fix the schema and re-run.

### The combined counter is intentional

`failedPairEdges` aggregates BOTH:
- Schema-preflight-skipped edges (pair not in `RELATION_SCHEMA`)
- COPY-failed edges (schema valid but COPY threw, e.g., constraint violation)

Both failure modes have the same downstream cost (individual inserts), so combining them in the throw guard is correct. Edge case: a schema-missing pair with 999 edges + 2 COPY failures = 1001 → throw, even though the COPY failures might be recoverable individually. Acceptable trade-off (logging both counts in the error message helps operators diagnose).

### Module-load-time parse caveat

`RELATION_SCHEMA` is a static const (template literal), NOT a function or lazy getter. The Set is populated synchronously at import time. If the schema is ever changed to be lazily generated, the Set would be empty at first import and route ALL edges to fallback — gracefully but disastrously slow.

### Test (`lbug-edge-limit.test.ts`, Wave 1.5 minor-fix-6)

The test triggers the 1000-edge guard by passing edges with a label pair not in the schema. Wave 1.5 minor-fix-6 changed the impossible pair from `Section→Class` (potentially valid in future schema) to `Community→File` (semantically impossible — Community is a Leiden cluster node; never directly connected to File by design).

```
test('throws when failed-edge count exceeds 1000', async () => {
  const handle = await withTestLbugDB(...);
  const edges = generateEdges(1001, 'Community', 'File');  // semantically impossible

  await expect(
    loadGraphToLbug(handle.tmpHandle.dbPath, nodes, edges),
  ).rejects.toThrow(/exceeds 1000-edge limit/);
});
```

The brittle-test mitigation: even if the schema is extended, `Community→File` will never become valid by design.

## Consequences

**Positive:**
- Fast-path: known pairs go through bulk COPY (orders of magnitude faster than per-edge insert)
- Graceful degradation: missing-schema pairs route to fallback without cryptic native errors
- Operational guardrail: 1000-edge threshold prevents runaway slowdown
- Test stability: semantically-impossible pair won't silently invalidate

**Negative:**
- Static module-load-time parse — schema must be eagerly evaluated
- The combined counter conflates two failure modes; recoverable COPY failures could lose data above the threshold
- Regex is hand-tuned to the current `RELATION_SCHEMA` syntax — schema reformat breaks the parse
- Throw message could be more diagnostic (split schema-missing vs copy-failed counts is a recommended improvement)

**Open issues for future work:**
- Split schema-missing vs COPY-failed counts in the throw message
- Per-pair retry strategy (e.g., 100 individual inserts before giving up on a pair)
- Schema evolution tooling (auto-update preflight when schema changes)
