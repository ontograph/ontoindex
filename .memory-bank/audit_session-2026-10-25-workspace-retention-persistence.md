# Workspace candidate persistence and cleanup accounting

Date: 2026-10-25. Authority: user continuation of the five-task scope.

## Implemented

Workspace-graph analysis now honors an explicit `dependencies.scopeRetention`
request. The existing writer persists candidates inside the staged overlay
generation, using the captured manifest digest, HEAD and committed base generation
identity. Publication syncs these files with the generation before changing CURRENT.
Symbols-only overlays and calls without a retention request retain their behavior.

Workspace and full-index consume callbacks measure the writer's outstanding
artifact charge in `finally`. This also covers a writer failure whose own cleanup
fails but whose outer generation cleanup succeeds. Successful outer cleanup refunds
that charge; unsuccessful cleanup keeps it charged. Transient stage disposal owns
its separate refund. A publication flag prevents deleting or refunding a published
workspace generation.

Changed product/test files: `ontoindex/src/core/run-analyze.ts`,
`ontoindex/test/unit/workspace-analysis-publication-order.test.ts`,
`ontoindex/test/unit/run-analyze-snapshot.test.ts`. Pre-existing dirty edits preserved.

## Review decisions

Generation-local persistence reuses the writer, bounds and publication lifecycle.
A separate cache duplicates lifecycle ownership; embedding records in base.json
bypasses the bounded candidate format. Second review found and corrected the
shared writer-cleanup budget leak before validation.

Admission review rejected trusting outer identities and completion flags alone.
Parser evidence hashes UTF-8 text; workspace capture hashes raw bytes. Import
configuration observations include absent files, directory listings and traversal,
and differ from the workspace configuration digest. Admission must compare fresh
evidence in the corresponding domain. Nullable base identities and unborn HEAD
must compare exactly rather than being rejected without a semantic reason.

The existing parse wrapper is the bypass owner. Reconstruction already stages graph
changes, but a production caller must establish admission, pin its candidate,
preserve cancellation and owner lifetimes, and fall back on ordinary mismatch.
Current conservative non-code inventory and unrelated configuration traversal
can prevent replay eligibility; weakening these gates is not justified by this work.

## Executed validation

Native commands ran serially in `ontoindex/`, with no detached jobs or containers.

- Vitest `run-analyze-snapshot.test.ts` and `scope-retention-candidate.test.ts`,
  `ONTOINDEX_TEST_WORKERS=4`, `--maxWorkers=1`: 60 tests passed, exit 0;
  session 17039. Includes real-writer inner cleanup failure and outer refund.
- Vitest workspace-analysis publication-order, durability and base-guard suites:
  26 tests passed, exit 0; session 31482.
- `ONTOINDEX_MAX_WORKERS=4 npm run build`: exit 0; session 62325.
- After adding real writer/reader coverage, publication-order suite rerun:
  18 tests passed, exit 0; session 61012. This supersedes its earlier result.
- Scoped tracked-file whitespace check: exit 0. OntoIndex bounded verify_diff:
  PASS for the three declared files; no symbol-scope claim because expectedSymbols
  was omitted. The publication-order test is pre-existing untracked source.

One build and three test invocations; 87 unique tests across the five suites have
passing evidence. Four researchers and two developers used gpt-6-luna/gpt-6.1-sol.
All commands completed. No installation, commit or publication performed.

## Remaining and tracker state

Strict same-source admission, pinned loading, actual production parser bypass,
fallback/invalidation/cancellation proof, edited-source composition, performance,
complete required-language Linux qualification and isolated installation/CLI/MCP
validation remain open. Persistence requires an explicit internal request; runtime
activation remains disabled and seedReady stays false.

The historical workspace tracker is closed with no selected task. Its current
manager_loop_next invocation returned invalid_tracking because old exact model
candidates differ from the active role policy's family selectors. No leased or
tool-owned tracking state was edited; this result does not authorize marking the
five-task scope complete. A bounded successor needs current dispatch policy.

OntoIndex HEAD/index matched 2623820ec85113c28b238d5f72dde496e27426a1;
dirty owners require source evidence. Committed impacts were LOW. Workspace
safe_edit_check returned workspace_too_large (1832 files, ceiling 1600);
no retry/reindex was performed.
