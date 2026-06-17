# ADR 0088 Tracking: Agent-Ready Context and Symbol Ergonomics

**Plan:** `docs/guides/adr-0088-pre-junior-project-plan.md`
**Status:** Implemented
**Started:** 2026-06-17

## Manager Notes

- No sub-agent spawn tool with enforceable `gpt-5.3-codex-spark` or `gpt-5.4-mini` model selection
  is available in this session.
- Manager/senior will implement the narrow pre-junior scope directly and keep each task small.
- T6/T7 are explicitly senior follow-up only and not part of this implementation loop.

## Task Status

| Task | Status | Owner | Notes |
| --- | --- | --- | --- |
| T1: Standardize symbol identity shape | Done | manager | Added pure `toSymbolIdentity` helper. |
| T2: Normalize ambiguous responses | Done | manager | Context and impact now include identity fields and retry calls. |
| T3: Accept `nodeId` alias | Done | manager | Central params normalization maps `nodeId` to `uid` / `target_uid`. |
| T4: Add retry examples to `gn_explore` | Done | manager | `topSymbols[]` now includes machine-readable retry examples. |
| T5: Add context completeness metadata | Done | manager | Context responses expose small completeness metadata. |
| T6: Agent-source profile | Postponed | senior | Not pre-junior scope. |
| T7: Dynamic boundary metadata | Postponed | senior | Not pre-junior scope. |

## Verification Log

- `npx vitest run test/unit/backend-context-bounds.test.ts test/unit/backend-impact-identity.test.ts test/unit/super/explore.test.ts` - passed, 14 tests.
- `npx tsc --noEmit` - passed.
- Broad `npm run test:unit -- backend-context-bounds backend-impact-identity super/explore` accidentally matched the full unit suite; 425 files / 6034 tests passed, then unrelated `tree-sitter-kotlin` native build failure occurred in `call-form.test.ts` and `type-env.test.ts`.
- `ONTOINDEX_MAX_WORKERS=7 node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js analyze` - passed, 37,193 nodes / 55,176 edges / 1,277 clusters / 300 flows.
