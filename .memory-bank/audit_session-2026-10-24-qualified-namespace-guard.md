# Qualified namespace fallback guard

Date: 2026-10-24
Task: NS-3A

## Change and review

The qualified lookup owner now contains an internal admission helper. Explicit
namespace tags on complete source spellings or dot-segment prefixes prevent
canonical fallback. It scans lexical bindings and namespace import edges, fails
closed on missing/cyclic chains, and leaves successful lexical resolution intact.
lookupCore opts in with lexicalNamespace; resolveTypeRef guards dotted fallback.
The adapter exposes finalized module imports, including edges without synthetic
definitions, while preserving authoritative empty arrays and absent-entry fallback.

Kind inference cannot encode per-import restrictions. Full alias traversal needs
authoritative export visibility absent from registry context. A conservative guard
was selected after two reviews as a bounded safety prerequisite. It deliberately
refuses some valid canonical matches rather than claiming unsupported visibility.
It adds no index/cache or global definition scan; no performance result is claimed.

Four Luna/Sol researchers and two Sol-medium developers participated. Independent
Luna core and Sol adapter source reviews found no blockers. Seven source/test
files are declared in the archived QUALIFIED_NAMESPACE_GUARD_PLAN.md tracker.
Existing dirty changes were preserved.

## Validation

| Command | Working directory | Result | Runtime evidence |
| --- | --- | --- | --- |
| `../ontoindex/node_modules/.bin/tsc` | `ontoindex-shared` | exit 0 | 3a6441 |
| `ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/registries.test.ts test/unit/scope-resolution/resolve-type-ref.test.ts test/unit/scope-resolution/finalize-orchestrator.test.ts test/unit/scope-resolution/finalize-algorithm.test.ts` | `ontoindex` | 192 tests; four suites; exit 0 | session 3732; a7be8b |
| `./node_modules/.bin/tsc --noEmit --incremental false` | `ontoindex` | exit 0 | session 17849; 8e98b3 |
| `git diff --check` on seven declared files | repository | exit 0 | d44b3b |

All writers froze files before parent validation. Budget used: 1/2 shared
compilations, 1/2 suites, 1/2 typechecks. No retries or child compile/test runs.
Rust formatting is inapplicable to this TypeScript checkout.

OntoIndex committed HEAD 2623820ec85113c28b238d5f72dde496e27426a1 is fresh.
lookupCore impact MEDIUM; resolveTypeRef and lookupQualified LOW. The newer adapter
is absent from the index. Workspace preparation still reports 1832 > 1600 files;
source inspection is authority for dirty changes. Declared-file verify_diff PASS;
symbol scope was not checked.

## Remaining gates

This is fallback refusal, not full export-aware alias resolution. Matching tags
also refuse fallback until member visibility can be proven. Canonical public
lookupQualified and selector-free wrappers remain unchanged. Receiver/owner paths,
provider capture, semantic replay admission, runtime acceptance and build/install
remain open. No deployment, runtime launch, performance gain or repair of the
original workspace-preparation failure is claimed.
