# MCP Three Corrections

Date: 2026-10-12
Outcome: Implemented and validated in the shared current-source checkout.

## Changes

- Resource renderers use the installed YAML serializer for dynamic string values, list entries, URI keys, errors, and memory metadata. Structured parameters remain objects; Markdown bodies retain their content.
- Graph summary query and mapping errors propagate through existing handlers. Requested overview failures reject the whole overview; successful empty queries retain empty lists.
- `gn_path_verify` uses bounded C/C++ parser observations for an exact procedure and unique trigger consequence. Neighboring procedures, alternative branches, comments, literals, nested control flow, and unreachable statements cannot supply the previous false proof. All outcomes are advisory `NEEDS-VERIFY`.
- Tool metadata, stable contract snapshot, and `ADR_MCP_SCOPED_OBSERVATIONS_AND_QUERY_FAILURES.md` record compatibility behavior.

## Validation

- Focused regression selection: 7 files, 183 tests passed, exit 0.
- Broader MCP regression selection: 100 files, 1,470 tests passed, exit 0, 34.52 seconds.
- TypeScript: `node node_modules/typescript/bin/tsc --noEmit --incremental false`, exit 0.
- Scoped OntoIndex `gn_verify_diff`: PASS for the five changed source owners. Symbol detail was absent; this establishes the declared file scope only.
- Formatting used installed Prettier on changed files. `git diff --check`: exit 0.
- Exact broad command, input hashes, selection, log, result, and post-run drift evidence: `/opt/d1/tmp/ontoindex-mcp-three-fixes-oj1m2q1m/`.

## Review and Limits

Four discovery/challenge agents and three implementation agents used gpt-6.1-sol and gpt-6-luna with disjoint writes. Independent review found literal erasure inventing matches; opaque literal handling and regressions corrected it. Validation corrected a metadata-wrapper assertion and unknown-field encoder typing.

OntoIndex stale/degraded: dirty source changes and scan-cap omissions; source inspection is authority. Path observations support C/C++ syntax with 256 KiB source, 5,000-node traversal, and parser time bounds. Syntax observations do not prove execution.

Concurrent edits were preserved. No commit, push, build of distribution artifacts, local installation, release, GitHub CI, CodeQL, reindex, or live-service restart was performed. Unrelated active plan state was preserved.

Knowledge handoff: none; receipt and validation corrections are already covered by the installed child-receipt-contract and validation-diagnosis rules.
