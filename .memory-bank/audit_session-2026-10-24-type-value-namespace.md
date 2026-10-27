# Type/value namespace prerequisite evidence

Date: 2026-10-24

Six agents participated: four bounded discovery reviewers on Luna/Sol, then two
Sol-medium developers with disjoint lookup and codec writes. Two researchers
reviewed the completed delta without executing validation.

The accepted [decision](ADR_TYPE_VALUE_NAMESPACES.md) compares kind inference,
separate maps and optional binding metadata. The second challenge retained
legacy shadow semantics and restricted NS-1 to lexical lookup and retention.
Imports/exports and qualified resolution remain explicit dependencies rather
than being silently inferred from symbol kind.

## Validation

All commands ran serially on the native Linux host:

| Command and working directory | Terminal evidence | Result |
| --- | --- | --- |
| `../ontoindex/node_modules/.bin/tsc` in `ontoindex-shared` | session 78589, terminal 6f2ddc | exit 0 |
| `ONTOINDEX_TEST_WORKERS=1 ./node_modules/.bin/vitest run test/unit/scope-resolution/registries.test.ts test/unit/scope-resolution/resolve-type-ref.test.ts test/unit/parse-worker-protocol.test.ts` in `ontoindex` | session 66219, terminal c3c840 | 88 tests, exit 0 |
| `./node_modules/.bin/tsc --noEmit --incremental false` in `ontoindex` | session 2716, terminal 24ce06 | exit 0 |

Shared lookup tests cover namespace separation with distinct IDs, omitted
selector, dual-space and untagged bindings, parent traversal and same-namespace
wrong-kind shadowing. Codec cases preserve each enum and missing versus explicit
undefined, reject eight invalid values on encode and tampered decode, and reject
unknown binding fields. Existing bounds and version remain unchanged.

OntoIndex HEAD/index matched 2623820ec85113c28b238d5f72dde496e27426a1.
Committed impact rated lookupCore MEDIUM and resolveTypeRef/codec LOW. Default
safe-edit refused workspace_too_large at 1832 > 1600. Batch committed impact
was unsupported; individual committed calls succeeded. Initial shorthand codec
target was absent; its exact encodeParsedFileRecord symbol resolved. No reindex.
Declared seven-file verify_diff passed; it did not check symbol scope.

One suite, one shared compilation and one product typecheck consumed of two
allowed each. No tests/builds by children; no runtime launch, deployment or
provider activation. Namespace filtering adds constant work per binding and no
filtered-array allocation; no performance benchmark or end-user speedup claimed.

Current-source workspace navigation remains blocked. This accepted prerequisite
does not establish end-to-end TypeScript namespaces or replay readiness.
