# Automatic workspace review and repairs

Date: 2026-10-20
Authority: User requested challenge, alternatives, a consolidated plan and execution.

Final manager state: closed, no active task; REV-1 through REV-4 are DONE.
[Consolidated plan](archive/ADW_REVIEW_REPAIRS_PROJECT_PLAN.md) retains the
comparison, task scopes and acceptance evidence.

## What went well, poorly and was forgotten

The original 83-task closeout is supported within its declared scope. Strong
points were frozen input/build identities, serial validation, real CLI/MCP
mutation replay and explicit unsupported capabilities. Oversized trackers and
stale release reports obscured current scope. Four new review packets identified
two concrete code defects, missing regression fixtures, one broken archived link
and essential feature guidance linked only from unshipped memory-bank files.

| Finding | Selected fix after two challenge passes | Rejected alternatives |
| --- | --- | --- |
| Expired caller admits work after slow snapshot/count probe | Recheck existing signal/deadline after awaits and before admission | Extra settlement owner duplicates state; shared-build cancellation harms other waiters |
| Concurrent warm callers repeat full input verification | Share existing pending snapshot entry, revalidate after settlement | Settled TTL reuse risks stale answers; serialized independent scans retain repeated work |
| Stale reports and unavailable packaged guidance | Current disposition plus preserved dated evidence; self-contained README; fixed link | Rewrite loses error provenance; reopening completed plans lacks supporting evidence |
| Historical native allocation errors | Require exact failing query/resource owner before changing pool behavior | Raising memory or changing capacity without reproduction is speculative |

Both fixes preserve APIs, mutation guards, fresh byte/config validation and
already-admitted shared builds. Pending sharing avoids duplicate work; there is
no new numeric latency or throughput claim.

## Development and validation

Four read-only gpt-6.1-sol medium reviewers covered runtime, performance,
lifecycle and evidence. Two further gpt-6.1-sol medium developers owned disjoint
production/test pairs and challenged each other's source changes. Parent checked
their receipts and hashes. OntoIndex supplied freshness, navigation, impacts,
safety and bounded verification. HEAD matches the index at acbcb638; dirty source
is absent from the graph and direct source remains authority. Exported APIs were
flagged DANGEROUS; signatures remain unchanged. Snapshot direct impact was
MEDIUM with six callers; a deeper developer query reported HIGH/32 dependents
before editing. Preparation direct impact was LOW/one caller.

Initial job `adw-review-repairs-20261020` exited 1: 371/390 tests passed.
Seventeen failures exposed the missing activation export in an old resolver
mock. Two new tests deferred the third queued snapshot response, after lock
admission, instead of the first. The single correction reuses the real helper
and resets that test queue; zero-build/zero-lock assertions remain strict.
Failure evidence is preserved.

Correction job `adw-review-repairs-20261020-r1` exited 0 in 13206 ms:
390 tests across six files passed in 11.72 seconds, TypeScript exited 0,
five input hashes matched and whitespace passed. Wrapper:
`.ontoindex/adw-validation/review-repairs-20261020/qualify-r1.sh`.
From `ontoindex/`, its commands include:

```sh
node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism test/unit/backend-overlay.test.ts test/unit/local-backend-repo-runtime.test.ts test/unit/calltool-dispatch.test.ts test/unit/mutation-dirty-guard.test.ts test/unit/overlay-query-merge.test.ts test/unit/overlay-symbol-resolution.test.ts
node node_modules/typescript/bin/tsc --noEmit -p .
```

It uses the existing serial flock, one worker and native global setup. Receipt:

```sh
env ONTOCODE_COMPILER_ARTIFACT_ROOT=/opt/d2/.ontocode/artifacts/compiler-lane /home/er77/.cargo/bin/just --justfile /opt/d1/_wrk/ontocode/justfile lane-result adw-review-repairs-20261020-r1
```

Receipt read exit 0. Final file inventory
`.ontoindex/adw-validation/review-repairs-20261020/final-files.json` has SHA-256
`1d363c084a0e6115c8baa740947d80422b03d7f515ad50dbb547a9ab3bf2b08e`.
Qualified checksum list SHA-256:
`6eccaf48314e5b09679df69a65c5be97054e74570040fc9c86f684f759c35756`.
Pre-edit copies and both wrappers remain beside them. Prior default/r4 frozen
evidence is unchanged. Scoped graph verification passes for five source/test
files. Changed guidance has zero missing local links; plan parser passes.

## Remaining boundaries and accounting

The real-time tracker records RT-5 and RT-28 DONE; earlier claims that RT-5
remained open were stale. Historical nineteen native allocation errors still
lack a demonstrated root cause. Future diagnosis must identify the exact query
and pool owner. Logical-pool capacity pressure and benchmark observer overhead
remain unmeasured hypotheses, with no speculative production changes selected.

Release qualification still requires current installed-tarball/native-addon
smoke, source/version identity and a native Linux release path. This repair did
not rebuild compiled output: it has focused source-test/TypeScript evidence,
without new installed-binary or full-matrix qualification. No publication,
commit, tag, provider call or new worktree was performed.

Budget: two focused invocations, one TypeScript invocation, one of one correction
rounds, zero builds/full suites/matrices. Both jobs are terminal. No unchanged
failure was rerun; correction followed concrete fixture diagnosis. No loop-rule
violation occurred. knowledge_handoff: none; existing manager and diagnosis rules
cover mock attribution, bounded retries and preserved failure evidence.
