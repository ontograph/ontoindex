# Automatic workspace final closeout

Date: 2026-10-20
Authority: User instruction to proceed all open tasks; direct recovery decision.

Both canonical managers are closed with no selected task:

- [Automatic workspace](archive/AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md): 34/34 DONE.
- [Independent review](archive/ADW_INDEPENDENT_REVIEW_IMPLEMENTATION_PLAN.md): 49/49 DONE.

ADW-8b and ADW-8c were accepted through `complete-local`. Existing role-result
and receipt history is retained; local evidence does not authenticate missing
historical child receipts. Active routers contain no remaining task in this scope.

Automatic workspace preparation is enabled when `ONTOINDEX_AUTO_WORKSPACE` is
absent or exactly `1`. Set `0` to disable it. The shared predicate covers eleven
production consumers; the benchmark disabled baseline explicitly sets `0`.

## Validation and identities

Canonical `just lane-result` reads confirm terminal exit 0 for:

| Managed job | Result |
| --- | --- |
| `adw-default-focused-20261020` | One offline build; 491 tests / six files; final freeze PASS |
| `adw-default-startup-20261020` | Two compiled startup tests / one file; TypeScript; final freeze PASS |
| `adw-iq12-matrix-20261020-r4` | Accepted twelve-group, 300-sample matrix |

The exact commands, receipt locations and scope are retained in the ADW plan's
Closeout. This continuation reuses terminal evidence; it launches no new build
or tests. Current `freeze.py verify` and `git diff --check` return exit 0.
Bounded OntoIndex `gn_verify_diff` passes for seventeen explicit production,
script and changed test files. Both canonical plan parsers pass.

HEAD: `acbcb63830cf51a8fc0537a76f4267e5be758167`.
Final evidence is under `.ontoindex/adw-validation/default-20261020/`:

| Artifact | SHA-256 |
| --- | --- |
| `candidate-inputs.json` | `b29cb13941e3cb36eb415a635c58146807a797fa134cdb43676ed4ecf7509242` |
| `build-outputs.json` | `898945209a99545202d7599038235807c109257bace1c545e373af0f99cf49d7` |
| `replay-default.json` | `3c91eae65e4115f8f6e10e21036a53c3cac87d5d1bb20093f017c653a1c5dfcd` |

Prior frozen full suites pass 11973 tests / 662 files each, with one expected
failure and 311 declared skips. Compiled SDK proof passes 23 tests / four files.
The matrix SHA-256 is
`4c39bb02fdb9606bc3641c47edc5f3f4b5eefb0fc0a40a103a6f2a63e38fad33`.
Final default replay retains 29 records, fifteen SDK requests and six compiled
CLI calls; all CLI exits are 0 with empty stderr. MCP exits 0, with retained
startup/capability notices and no native errors. Descendant cleanup is 94.585 ms.

## Remaining scope and accounting

Supported reads use bounded captures of on-disk inputs. Unsaved buffers, dynamic
or external resolver inputs, new vectors and atomic cross-repository snapshots
remain outside coverage. RSS is sampled, OS caches are unflushed, the matrix
raises the corpus file gate, contention observes generation counts and parity
uses a selected probe. RT-5 and native buffer-pool investigations retain their
separate scope. [The audit](ADW_INDEPENDENT_REVIEW_AUDIT.md) preserves details.

OntoIndex matches HEAD but excludes uncommitted source from its symbol graph;
source inspection and frozen runtime evidence govern the dirty candidate.
Default activation consumed its allocated one build, one focused suite, one
compiled replay and one TypeScript invocation, all successful. Prior two
correction rounds remain consumed; closeout adds none. Four-agent review and
implementation packets were completed earlier; no duplicate fanout was needed.
No commit, publication, provider call or new worktree was performed.

`knowledge_handoff: none`: existing manager/build rules already cover terminal
receipts, frozen evidence reuse and compiler-lane ownership. No additional
loop-protection violation occurred during closeout. No blocker remains for
these two closed plans; release publication is outside the completed scope.
