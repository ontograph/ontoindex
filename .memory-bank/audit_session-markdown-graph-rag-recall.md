# Audit Session: Markdown Graph-RAG Recall

Date: 2026-10-13
Commit: baseline measured at 7b1494c with the changes then uncommitted; all measured changes have since shipped in PRs #94, #95 and #96 (later sections record each re-measurement)
Sidecar: `ontoindex docs sidecar run markdown` status complete, 126 records.
CLI: `npm run build` in `ontoindex/` before measuring; `dist/` contains `scoreMarkdownChunks`.

| Query | Expected | Position in relatedDocs | Response bytes |
| --- | --- | --- | --- |
| how to add a new pipeline phase | ARCHITECTURE.md | 1 | 436997 |
| index is stale | RUNBOOK.md | 3 | 148860 |
| enable embeddings | RUNBOOK.md | 4 | 227811 |
| pre-commit hook | TESTING.md | 1 | 218993 |
| LadybugDB lock database busy | GUARDRAILS.md | 1 | 271423 |
| report a vulnerability | SECURITY.md | absent | 263801 |
| adding a language parser | CONTRIBUTING.md | absent | 240642 |
| METHOD_OVERRIDES migration | MIGRATION.md | 1 | 250674 |
| kubernetes helm chart (off-topic) | none | 2 related docs returned | 79552 |

Before the change, the first query returned `.memory-bank/archive/` plans only and a 7.1 MB response.

Findings:

- Six of eight expected documents rank in the top 5. The two absent documents, `SECURITY.md` and `CONTRIBUTING.md`, are listed in `ontoindex/src/config/ignore-service.ts:360-372`, so the sidecar never indexes them. Every indexable expected document ranks in the top 5.
- Off-topic query still returns 2 documents because it shares a word with some chunks; it is not empty as in the unit fixture.
- Responses are 79-437 KB, down from 7.1 MB, and `facts` is cut from 7,776 to 146. The remaining size comes from chunk excerpts, evidence and PPR output.
- Non-reference documents (`.ontocode/research-reports/`, plan and test-plan files in the repository root) rank above reference documents for "report a vulnerability". `MARKDOWN_ARCHIVE_WEIGHT` covers only `.memory-bank/archive/` and `audit_session-*`.

Decision: no embeddings follow-up (6 of 8 positions are 1 to 5, the threshold in GR-5.0).

## Re-measurement after review fixes (2026-10-14)

Changes: unresolved code mentions dropped from `facts`; non-Markdown visible records kept; document chunk counts recomputed after the query filter; link lookup uses a map; Unicode NFC and single-character tokens; low-authority weight extended to plan, test-plan, release-readiness, release-notes and research-report paths.

| Query | Expected | Position | Bytes |
| --- | --- | --- | --- |
| how to add a new pipeline phase | ARCHITECTURE.md | 1 | 230966 |
| index is stale | RUNBOOK.md | 2 | 167905 |
| enable embeddings | RUNBOOK.md | 3 | 143616 |
| pre-commit hook | TESTING.md | 1 | 218993 -> 172848 |
| LadybugDB lock database busy | GUARDRAILS.md | 1 | 201270 |
| report a vulnerability | SECURITY.md | absent (not indexed) | 191949 |
| adding a language parser | CONTRIBUTING.md | absent (not indexed) | 168888 |
| METHOD_OVERRIDES migration | MIGRATION.md | 1 | 178430 |
| kubernetes helm chart (off-topic) | none | 2 related docs ("chart" matches lexically) | 47890 |

Queries with no lexical match ("banana smoothie recipe", "zebra quantum marmalade") return 0 documents, 0 chunks and about 4 KB.

Size breakdown of the largest response before the fix (437 KB): `facts` 147 KB (112 KB unresolved code mentions), `relatedChunks` 58 KB, `relatedDocs` 46 KB, `markdownPpr` 67 KB. `relatedDocs` repeats per-chunk freshness records.

Decision unchanged: no embeddings follow-up.

## Re-measurement after payload trim and root-file allowlist (2026-10-14)

Changes: document `freshness` de-duplicated (92 entries, 5 distinct, to 5); `visibleRecords` follows the returned chunks; PPR `skipped` capped at 5 with `summary.skippedTotal`; the Markdown sidecar reads `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `LICENSE.md` at the repository root (regular files only, user ignore rules and the scan-size cap still apply). Sidecar rerun: 131 records (was 126).

| Query | Expected | Position | Bytes |
| --- | --- | --- | --- |
| how to add a new pipeline phase | ARCHITECTURE.md | 1 | 134917 |
| index is stale | RUNBOOK.md | 2 | 86323 |
| enable embeddings | RUNBOOK.md | 3 | 84325 |
| pre-commit hook | TESTING.md | 1 | 94681 |
| LadybugDB lock database busy | GUARDRAILS.md | 1 | 88865 |
| report a vulnerability | SECURITY.md | 1 | 118038 |
| adding a language parser | CONTRIBUTING.md | 1 | 107413 |
| METHOD_OVERRIDES migration | MIGRATION.md | 1 | 108652 |
| kubernetes helm chart (off-topic) | none | 3 related docs ("chart" matches lexically) | 58416 |

Result: 8 of 8 expected documents in the top 5, 6 of 8 at position 1. Responses 58-135 KB (7.1 MB before the plan, 79-437 KB after the first round, 48-231 KB after the review fixes).

After the allowlist change, the sidecar status read `stale` before the rerun (not `partial` as predicted from source reading); the rerun made it `complete`. Existing sidecars need `ontoindex docs sidecar run markdown` once.

Decision unchanged: no embeddings follow-up.

## Mention boost and store cache evaluation (2026-10-14)

- Mention boost replayed on the 8 live queries: no expected document changed rank at factors 0.15, 0.25 or 0.5, while off-topic documents were promoted; rejected.
- Mention facts: 4,644, all `unresolved` with confidence 0; 19.7% (916) have text equal to a graph symbol name, 55% of 674 identifier-shaped mention texts exist in the graph.
- Store: 8.26 MB; `loadSidecarStoreState` median 19.8 ms; Markdown-enabled metadata path 50.9 ms; cache rejected (clone cost 13.5 ms).
- Branch `feat/markdown-graph-rag-ranking` rebased on `origin/master` (52ab1d1): 20 test files, 406 tests pass, `tsc` 0 errors.

## Mention resolution (2026-10-14, PR #96)

Method: CLI built from `origin/master` (1c2dcac) versus the PR branch, same registered repo (`ontoindex`, indexed commit 7b1494c), the eight recall queries with `--consume-enrichment-facts --include-passive-related-facts --include-markdown-context --include-markdown-ppr`, 3 runs each, wall time of the whole CLI process.

| Query | Added bytes (first design, ambiguous targets listed) | Added bytes (final, ambiguous = count only) |
| --- | --- | --- |
| how to add a new pipeline phase | +49,654 | +24,043 |
| index is stale | +6,582 | +3,255 |
| enable embeddings | +7,019 | +2,835 |
| pre-commit hook | +8,021 | +6,302 |
| LadybugDB lock database busy | +5,535 | +3,991 |
| report a vulnerability | +4,785 | +2,987 |
| adding a language parser | +25,584 | +14,015 |
| METHOD_OVERRIDES migration | +42,918 | +18,797 |

- Resolution mix on "METHOD_OVERRIDES migration" (first design): 18 resolved, 32 ambiguous, 28 unresolved of 78 mentions; ambiguous target lists were about 75 percent of the added bytes, so the final design reports `candidateCount` and no targets for ambiguous names.
- `mentionResolution` was `ok` with 9 to 37 lookups per query. Per-query median wall time was 1.26 to 1.51 s with the change versus 1.47 to 1.80 s on master; the difference is below the machine noise between runs, so no added latency is measurable at CLI granularity (median 1,328 ms versus 1,557 ms, p95 1,464 versus 1,799). In-process lookup cost was not isolated.
- Stop condition in MR-3.0 (growth above 20 KB): met for one query (+24 KB on a 137 KB response, 18 percent). Median growth across the eight queries is about 4.7 KB. Not tuned away; decision left to the reviewer.
- Caveat: the index is at 7b1494c, so symbol ids in resolutions come from an older graph than the sidecar. Counts of resolved versus unresolved depend on that.

### Mention resolution, third measurement: per-response map (MR-4.0)

Chunk evidence keeps only `mention`; results move to a response-level `mentionTargets` map keyed by mention text, resolved and ambiguous entries only (at most 40). Same method as above, 3 runs per query against `origin/master`.

| Query | Added bytes |
| --- | --- |
| how to add a new pipeline phase | +16,384 |
| index is stale | +2,019 |
| enable embeddings | +2,082 |
| pre-commit hook | +4,133 |
| LadybugDB lock database busy | +3,240 |
| report a vulnerability | +1,753 |
| adding a language parser | +8,560 |
| METHOD_OVERRIDES migration | +11,521 |

- Growth: median 3.7 KB, maximum 16.4 KB (the 20 KB stop condition now holds for all eight queries; it was 24 KB with per-item attachment).
- Wall time (whole CLI process): median 1,466 ms versus 1,557 ms on master, p95 1,897 versus 1,799 ms. The p95 difference is within run-to-run noise on this machine; lookup cost was not isolated.
- Offline estimate used to choose the design on the heaviest query: per-item attachment +19.0 KB, per-item with unresolved omitted +16.8 KB, resolved-only +11.9 KB, hoisted map +11.3 KB.

Later merged work: #96 query-time mention resolution; #98 analysis-coordinator test polling ceilings; #99/#100/#102 CI workflow hardening; #101 the 25-fact per-(chunk, fact kind) cap; #103 release 2.3.4; #104 integration test fixes. See the retrieval plan’s “Later merged work” closeout for commits and payload measurements.

## Answer grounding

Run on `0fe72ad` with `/tmp/measure-answer-grounding.mts` against `git ls-files`.

```json
{"files":43,"pathCitations":270,"ungroundedPaths":40,"medianMs":0.27,"maxMs":5.26}
```

Samples (first 10):

```text
.memory-bank/DONOR_LTM_ANSWER_GROUNDING_PROJECT_PLAN.md: docs/x.md
.memory-bank/MARKDOWN_GRAPH_RAG_RETRIEVAL_PROJECT_PLAN.md: docs/x.md
.memory-bank/MARKDOWN_GRAPH_RAG_RETRIEVAL_PROJECT_PLAN.md: docs/architecture.md
.memory-bank/MARKDOWN_GRAPH_RAG_RETRIEVAL_PROJECT_PLAN.md: docs/runbook.md
.memory-bank/MARKDOWN_GRAPH_RAG_RETRIEVAL_PROJECT_PLAN.md: docs/embeddings.md
.memory-bank/MARKDOWN_GRAPH_RAG_RETRIEVAL_PROJECT_PLAN.md: docs/testing.md
.memory-bank/MARKDOWN_GRAPH_RAG_RETRIEVAL_PROJECT_PLAN.md: docs/security.md
.memory-bank/MARKDOWN_GRAPH_RAG_RETRIEVAL_PROJECT_PLAN.md: docs/locks.md
.memory-bank/MARKDOWN_GRAPH_RAG_RETRIEVAL_PROJECT_PLAN.md: memory-bank/archive/old-plan.md
.memory-bank/MARKDOWN_GRAPH_RAG_RETRIEVAL_PROJECT_PLAN.md: docs/zz-architecture.md
```

Share reported: 40 / 270 = 0.148. Nearly all samples are example paths inside plan documents (`docs/x.md`, `docs/architecture.md`), which do not exist, so they are correct detections.

Decision: Wiring is allowed in a separate plan; this plan does not wire it.

## Answer verify CLI

Built from `feat/answer-verify-cli` (base `0fe72ad`); command `node ontoindex/dist/cli/index.js docs verify-answer <file> [--json] [--strict] [-r <repo>]`.

| Run | Exit | Status | symbolCheck | grounded / ungrounded / unverifiable | Wall time |
| --- | --- | --- | --- | --- | --- |
| Donor plan, indexed repo (`/opt/d1/_wrk/ontoindex`, index at `7b1494c`) | 0 | ungrounded | ok | 0 / 15 / 5 | 252 ms |
| Mention-resolution plan, indexed repo, `--strict` | 1 | ungrounded | ok | 15 / 14 / 11 | 275 ms |
| Donor plan, repo without an index | 0 | ungrounded | skipped | 0 / 5 / 15 | 81 ms |
| Mention-resolution plan, repo without an index, `--strict` | 1 | ungrounded | skipped | 0 / 11 / 29 | 83 ms |
| Donor plan, current worktree (not registered) | 0 | ungrounded | skipped | 4 / 1 / 15 | not timed |
| Mention-resolution plan, current worktree | 0 | grounded | skipped | 11 / 0 / 29 | not timed |
| Missing input file | 1 | message `Cannot read ...` | n/a | n/a | n/a |

Findings:

- Without an index every symbol citation is reported unverifiable, never ungrounded, and a warning is printed; no stack trace in any run.
- The indexed run used the stale main checkout, so its path list (`git ls-files` at `7b1494c`) lacks files added since; paths such as `markdown-answer-grounding.ts` are correctly absent there. Only the worktree runs reflect current `master`: the donor plan's one ungrounded path is the example `docs/x.md`.
- False positives remain for plain identifiers that contain an underscore, for example `node_modules` and `allowed_write_set` in backticks, which the grounding module treats as code-like symbols. This was not changed because the module is outside this plan's write set.
- Registering a worktree as an indexed repo was not attempted, so a symbol-check run against a fresh index of current `master` is still open.

