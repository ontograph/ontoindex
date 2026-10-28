# Luna workspace completion: archived checkpoints

Older prose checkpoints moved out of the plan to stay under the validator size limit. The plan remains the authority.

Checkpoint 2026-10-24 (items 1-2 of the six remaining gates):
- Candidate reader (scope-retention-candidate-reader.ts) now rejects duplicate
  inventory paths, duplicate input-evidence source paths, duplicate or
  out-of-inventory parsed-file paths, duplicate graph node and relationship ids,
  retained status with a non-retained inventory entry, and a parsed-file count
  that disagrees with a retained or completed parsed-files producer. Endpoint
  existence, auxiliary-family path membership and registration owner checks were
  rejected as false-reject risks; tests assert they still verify.
- C++ temporary receivers: real-parser fixtures show the outer call is retained
  (Foo().bar() with receiver Foo; make().run() with a mixed-chain make) and the
  inner call is skipped by design; onIncomplete stays unfired. No product change.
  The worker uppercase branch omits argCount versus sequential; unverified impact.
- Foreground validation: 103 tests in two files passed, exit 0; tsc no-emit
  exit 0; whitespace check clean. Resolved CALLS edge parity is still unproven.
- Items 3-5 (replay parity, source-owned graph replacement, runtime acceptance)
  need a separate design packet; no harness compares replay with full analysis.
- Item 6 delivery: native Linux build (ONTOINDEX_SKIP_EXT_FETCH=1
  npm_config_offline=true JOBS=4 npm run build) exit 0; npm pack --ignore-scripts
  tarball SHA256 10e590cbf8efa7cca72739980a3aee8a43954f72e5d124814038d00401bca712;
  isolated offline install exit 0. First CLI start failed on the missing LadybugDB
  native module, one npm rebuild repaired it, CLI then reported 2.3.5-rc.12 and a
  fresh MCP handshake listed 14 tools (core profile). Installed reader module hash
  equals the built hash. Candidate:
  /home/er77/.local/opt/ontoindex-2.3.5-rc.12-reader-20261024. No version bump,
  no push. Active MCP config still points at ontoindex-2.3.5-rc.12-core-20261023c;
  a client reconnect with the new launch path is needed. /opt/d1 stays 95% used.

Checkpoint 2026-10-24 (items 3-5, second pass):
- Replay parity: new test/integration/scope-retention-replay-parity.test.ts runs
  runPipelineFromRepo on a two-file TS fixture in sequential and real-worker mode,
  replays all eleven retained families into a fresh graph and compares node ids and
  CALLS plus ACCESSES-write edges against the final producer graph; sequential and
  worker producers also agree. 3 tests passed, tsc no-emit exit 0. Limits: the
  producer graph is read after later phases, not at consume time; one small fixture
  inside the supported TS capture subset (the mini-repo fixture throws the
  unsupported-subset error, so that language path stays a capture gap); the forced
  recovery path is covered only by the existing one-file worker-pool test.
- Graph replacement and runtime acceptance: design packet
  .memory-bank/GRAPH_REPLACEMENT_DESIGN_PACKET.md (three designs, second review,
  recommended conservative replay plus bounded full-analysis fallback, owner split,
  fixtures, measurement contract). Design only; nothing implemented or measured.

Checkpoint 2026-10-24 (parity harness, third pass):
- Parity test now has three modes: sequential, real worker pool and forced
  recovery (worker protocol error then sequential fallback, stub kept outside the
  scanned repo). Fixture is three TS files with named, aliased and namespace
  imports plus a missing callee. All three producers agree with each other and
  with the replay; CALLS targets for helper, other and run are asserted and the
  missing callee must yield no edge. 4 tests passed, tsc no-emit exit 0.
- Capture subset finding: the TS/JS scope capture accepts only identifier-named
  functions with simple bodies, empty classes, literal/identifier/call/new
  initializers, simple-receiver member calls and named, aliased, default and
  namespace imports. It rejects class methods and fields, extends, type
  annotations, generics, async/await, template literals, optional or nested
  member calls, spread, import type and re-exports (typescript-captures.ts, also
  asserted in test/unit/scope-resolution/typescript-captures.test.ts). Real
  repositories hit this refusal, so the parity proof cannot cover member CALLS or
  heritage. This is the dominant open Capture gap.

Measurement 2026-10-24 (corrects the previous "start with class methods" advice):
parsed all 681 .ts files under ontoindex/src with the tree-sitter parser and
counted syntax kinds the subset rejects. Files containing each kind: type
annotation 660, interface 421, type arguments 503, template string 406, if
statement 574, arrow function 461, async 266, for-in/of 357, try 228, class
declaration 44, class method 124, re-export 27. Only 3 files contain none of the
rejected kinds; 20 contain no type syntax at all. Files blocked by exactly one
feature: type annotation 16, re-export 15, template string 1, arrow function 1.
So class methods alone unblock almost nothing; control flow, type syntax, arrows
and templates all gate real files together. The refusal is the ADR's deliberate
fail-closed contract (ADR_AUTOMATIC_DIRTY_WORKSPACE.md: unsupported inputs retain
typed refusal), so widening is a multi-feature capture project, not a slice.
No product change was made. Counts come from a one-off script (removed) and are
syntax-kind presence, not a prediction of capture success.

Refusal-path measurement 2026-10-24 (option 3, typed refusal as shipped behavior):
ran runPipelineFromRepo from the built dist, sequential, on a 682-file copy of
ontoindex/src (not a git repository), baseline versus scopeRetention consume.
Result with retention: status incomplete, seedReady false, inventory failed 680
of 681, retained records 0, inputEvidence incomplete, reasons failed and
deadline. Graph output identical (25177 nodes, 38536 relationships). Wall time
107.8 s baseline versus 108.4 s with retention; peak RSS 819 MiB versus 826 MiB.
Caveats: one run each, dominated by repeated git-mining failures because the copy
is not a repository, so the overhead figure is an upper bound on noise, not a
benchmark; the deadline reason is an artifact of my 100 s request deadline being
shorter than the 108 s run. Findings: (1) the refusal is safe and cheap, the
candidate stays incomplete and no replay seed is offered; (2) the reason is not
actionable: every refused file collapses to status failed with reason
scope-extraction-error (scope-extractor-bridge.ts), so a consumer cannot tell
unsupported syntax from a parser crash, and the stage reports only the generic
reason failed; (3) each refused file emits one console.warn (680 lines per run).
Smallest follow-up slice: a distinct unsupported-syntax reason carried through
ScopeExtractionOutcome, worker recording and stage inventory, with one warning
summary per run; needs impact review of the worker protocol and stage validators.
Measurement scripts and the copy were removed.

Checkpoint 2026-10-24 (typed refusal reason slice): new
ontoindex/src/core/ingestion/scope-unsupported-syntax.ts defines
ScopeUnsupportedSyntaxError. All seven refusal throws in the six TS/JS capture
files now throw it with byte-identical messages. extractParsedFileOutcome maps it
to { status: failed, reason: unsupported-syntax } (ScopeExtractionOutcome and
ScopeExtractionRecord unions widened); any other thrown Error stays
scope-extraction-error. ScopeRetentionStage.recordOutcomes additionally records
the issue unsupported-syntax next to failed. Warning text and per-file warning
count are unchanged: the one-summary-warning-per-run idea was NOT implemented.
Existing assertions updated where the fixture hits a refusal helper
(parse-worker-scope-integration lines 169, 291, 353, 763; parse-fallback 94;
worker-pool 101; parse-impl-fallback reasons). Mocked-provider and synthetic
outcome assertions keep scope-extraction-error. New
test/unit/scope-unsupported-syntax-reason.test.ts. Validation: 32 files, 1603
tests passed after rebuilding dist (the real-worker tests read dist, and failed
on the stale build before the rebuild); tsc no-emit exit 0; whitespace clean.
Persisted candidate format is unchanged. Not done: no install of this build, so
the installed reader candidate predates the slice.

Checkpoint 2026-10-24 (item 6, typed-refusal candidate install): built from the
typed-refusal slice and installed locally at
/home/er77/.local/opt/ontoindex-2.3.5-rc.12-reason-20261024 (offline
npm install --ignore-scripts plus one npm rebuild for the LadybugDB native
module). Tarball /opt/d1/tmp/ontoindex-reason-20261024-artifacts/ontoindex-2.3.5-rc.12.tgz,
SHA256 f6081f0a378fd03ebd75a580d61f408f1f50c23c261542ee9c48989da41bf9df
(re-verified). CLI --version prints 2.3.5-rc.12; 721 of 721 built dist js files
match the installed copy; MCP handshake smoke listed 8 tools; a direct check
returned unsupported-syntax for ScopeUnsupportedSyntaxError and
scope-extraction-error for a plain Error. Version stays rc.12: no bump, no push,
no publish. The active MCP config still points at
/home/er77/.local/opt/ontoindex-2.3.5-rc.12-core-20261023c, so this connection
does not run the new build until the client reloads with the new path. Not
claimed: seedReady stays false, graph replacement, runtime acceptance
(cancellation, publication rollback, large dirty-workspace timing) and the
7001-file wall time/RSS remain unmeasured and open.

Checkpoint 2026-10-24 (consolidated plan, slices 1-2): three options were
compared per issue and challenged twice; two Sol-medium developers and two Luna
reviewers ran with disjoint write sets, and the parent ran all validation in the
foreground. Slice A (graph primitive): KnowledgeGraph.removeNodesByFiles
(graph.ts, types.ts, graph.test.ts, git-mining.test.ts mock) removes nodes by
filePath in one nodeMap pass and one relationshipMap pass and returns
removedNodes, removedRelationships and sorted affectedSourceIds (surviving
sources that lost an outgoing edge to a removed node). removeNodesByFile now
delegates and keeps its contract. Committed impact LOW; reviewer found no other
implementors. Slice B (C++ arity): the worker language-specific call push in
parse-worker.ts dropped argCount (proven by reading source; the new
cpp-worker-argcount-parity.test.ts fails without the one-line fix and passes
with it). The same omission in the sequential resolveExtractedLanguageCallSite
call to resolveCallTarget (call-processor.ts) was fixed with the same
conditional copy; this makes arity overload filtering apply to language-specific
call sites on the sequential path and has no dedicated regression test yet, only
the existing suites. Validation: tsc exit 0 (twice); build exit 0; 18 files 737
tests passed (7 skipped) before the call-processor change, and 13 files 449
tests passed (7 skipped) after it. Not done: removeNodesByFiles has no
production caller yet; dist and the installed rc.12 candidate predate both
fixes; no push. Next slice recommended by the seed-gate reviewer: schema-only
per-language coverage and refusal evidence in the candidate manifest and reader,
failing closed on unknown inputs, with seedReady kept false.

Checkpoint 2026-10-24 (slice C, per-language coverage evidence): two Sol-medium
developers with disjoint write sets, one Sol-medium test developer and one Luna
consumer reviewer; the parent ran all validation in the foreground. The stage
inventory entry now carries an optional reason, exactly unsupported-syntax, set
only for refused files and cleared when a later outcome replaces it
(scope-retention-stage.ts). New scope-retention-coverage.ts summarizes the
inventory per language (getLanguageFromFilename, unknown bucket) into files,
retained, skipped, refused, unaccounted and refusal reasons plus complete. The
candidate manifest gains a coverage field after retention (version stays 2,
seedReady stays false) and the reader recomputes it and rejects any mismatch,
missing or extra key, and an invalid inventory reason. Coverage is descriptive
evidence only and is never seed admission. Sequential argCount fix now has a
regression test (call-processor-language-argcount.test.ts): both arity cases
fail with the call-processor.ts line removed and pass with it. Existing
assertions updated for the new reason in scope-unsupported-syntax-reason and
parse-impl-fallback. Validation: tsc exit 0; build exit 0; 9 focused files 449
tests passed; 46 wider files 1912 tests with the four reason-assertion failures
fixed and re-run (parse-impl-fallback 73 passed). Known limits from review:
filename-only language mapping misclassifies extensionless shebang files as
unknown; the manifest stays under the 1 MiB cap but a 7001-file inventory may
already be close, so the added summary is a few hundred bytes at most and no
size measurement was taken. Not done: installed rc.12 candidate predates slices
A to C; no push; seedReady false; graph replacement, cancellation, publication
rollback and the 7001-file measurement remain open.

Checkpoint 2026-10-24 (item 6, coverage candidate install): built after slices
A to C and installed locally at
/home/er77/.local/opt/ontoindex-2.3.5-rc.12-coverage-20261024 (npm pack
--ignore-scripts, offline npm install --ignore-scripts, one npm rebuild for the
LadybugDB native module). Tarball
/opt/d1/tmp/ontoindex-coverage-20261024-artifacts/ontoindex-2.3.5-rc.12.tgz,
SHA256 422eaa58f3c3db64a4d67a185a94449fc131415ea912e6a97b6c597d94f13149.
CLI --version prints 2.3.5-rc.12; 722 of 722 built dist js files match the
installed copy; the coverage, argCount and removeNodesByFiles markers are
present in the installed dist; a direct run of the installed summarizer and
graph primitive returned the expected coverage record and
{removedNodes:1, removedRelationships:1, affectedSourceIds:[n2]}; an MCP
handshake listed the 8 public tools. Version stays rc.12: no bump, no push, no
publish. ~/.ontocode/config.toml still points the ontoindex MCP server at
ontoindex-2.3.5-rc.12-core-20261023c and was not edited, so this connection does
not run the new build until the client reloads with the new path. Supersedes the
reason-20261024 candidate. Still open: seedReady false, graph replacement,
cancellation, publication rollback and the 7001-file wall time/RSS.

Checkpoint 2026-10-24 (process kill during publication): extended
`dirty-overlay-publication-late-failure.test.ts` with a killed-process
leftover (orphan generation directory with a truncated database plus an
unpublished `.CURRENT-<id>.tmp`). CURRENT bytes stay unchanged, and the next
build publishes a new, correctly digested generation. A failed CURRENT rename is
already covered by `overlay-generations.test.ts` (injected rename failure keeps
CURRENT and the directory listing). Finding: pruning only matches generation
directory names, so an orphan `.CURRENT-*.tmp` (about 25 bytes) is never
removed; the byte budget impact is negligible and no cleanup code was added.
Orphan generation directories are pruned by the normal keep-three rule. Gates
remain open; no push; `seedReady` unchanged.

Checkpoint 2026-10-24 (real-child cancellation): added
`test/integration/workspace-build-real-child-cancel.test.ts`. It runs the
compiled `dist/core/workspace-build-child.js` under `superviseWorkspaceBuild`
against a real git fixture, aborts once the replacement generation directory
appears, and asserts kind `cancelled`, CURRENT bytes unchanged, the overlay
listing equal to the pre-build listing, empty `workspace-inputs`, no owner
marker, and a successful rebuild afterwards. The suite skips when `dist` is
absent. A mutant that skipped artifact cleanup on cancel was caught and the file
was restored byte-for-byte. This covers the supervisor and real child, not the
MCP transport hop (already covered by `mcp-workspace-cancellation-sdk.test.ts`
with a mocked build). Large-workspace performance is still unmeasured; gates
remain open; no push.

Checkpoint 2026-10-24 (large-workspace measurement): measured on a throwaway
local clone of the Ontocode checkout (10,306 tracked files, 8 cores, 109 GB RAM)
using the compiled `dist` build. Full `ontoindex analyze`: 58 s, 3.2 GB peak.
Working-tree overlay build through `workspace-build-child.js`: 96 s to 110 s and
3.5 GB peak on three runs; an in-process run took 103 s with phase timings
capture 16 s, pipeline 67 s (parse 56 s, communities 10 s), lbug load 12 s, FTS
6 s, and published a 381 MB generation with coverage `partial` (80 parse errors).
Findings: (1) the first child run died with `free(): invalid pointer` (SIGABRT)
after the pipeline, leaving `lbug` without `base.json` or CURRENT; the two
later child runs and the in-process run succeeded, so this native crash is
intermittent (1 of 4 builds) and unexplained. The supervisor treats any non-zero
exit as a failed build and removes the artifacts. (2) Capture refuses this
checkout as it stands: two tracked symlinks ('.memory-bank/_lr_validate.md',
'ontocode-rs/vendor/bubblewrap/LICENSE') and eleven tracked files over the
512 KiB scan cap (largest 6.9 MB) each abort capture with no partial result. The
measurement removed the symlinks and listed the large files in
`.ontoindexignore` in the clone only; the live checkout was not changed. (3)
Build time of about 100 s exceeds the default 60 s caller wait and the ADR's 55 s
dirty-cold limit, and sits close to the 120 s build deadline, so the 1,600-file
cap is a time bound. No cap, deadline or source change was made. Gates remain
open; no push.

Checkpoint 2026-10-24 (SIGABRT diagnosis attempt): ran the compiled
`workspace-build-child.js` six times under gdb (batch mode, backtrace on
SIGABRT/SIGSEGV/SIGBUS) on a fresh throwaway clone with the same two repairs as
the earlier measurement (symlinks removed, large files ignored). All six exited
normally in 95 s to 102 s; no signal fired and no backtrace was produced. Across
every child or in-process overlay build so far the tally is 1 abort in 10 builds
(the abort was the first child build in its clone, preceded by two child runs
that exited at capture limits and left an empty overlay directory). The abort
did not recur and stays unattributed: no component is blamed and no production
code was changed. An earlier full CLI analyze that exited with
`double free or corruption` (audit_session-2026-10-11-release-readiness.md)
also did not recur under gdb, so both records point to a rare native fault. Next
evidence step if needed: enable core dumps (`ulimit -c unlimited`; apport is the
system core handler) on non-gdb runs so a rare abort leaves a usable core. Gates
remain open; no push.

Checkpoint 2026-10-24 (capture refusal diagnostics): the full-walk branch of
`workspaceConfigurationPaths` in `src/core/analyze-delta.ts` no longer aborts at
the first tracked symlink or file over the scan cap. It walks the whole tree,
keeps the immediate errors for file-count and total-byte overflow and for special
files, and then raises one error that names every symlink and oversized file
(first 20 sorted, with a remainder count), the cap in KiB, and the remedy
(`.ontoindexignore`; configuration files cannot be excluded). Code is
`unsupported` when any symlink is present, otherwise `limit`. Oversized files do
not count toward the byte budget. The refusal itself is unchanged: nothing is
skipped silently and no cap moved. On a clone of the real Ontocode checkout the message now
reports 1 symlink and 2 oversized files in one response. That is fewer than the
2 tracked symlinks and 11 tracked files over the cap counted by hand earlier, so
the likely cause is that the walk's ignore rules drop some of them (binary
assets such as images and PDFs), but this was not checked; the earlier hand
counts must not be reused as the refusal set. A full capture of that checkout was not re-run after this change.
Three tests in `workspace-input-capture.test.ts` cover the combined
report, the oversize-only `limit` code, and success once all four paths are
ignored. Two mutants (first-offender abort; oversize counted as symlink) were
each caught and the file restored. Validation: 3 files and 123 tests pass, tsc
exit 0, and 13 of the 14 files that import this module pass. The 14th,
`workspace-capture-toctou.test.ts`, fails 17 of 26 tests with or without this
change: its `pendingCaptures` helper lists `capture-*.owner.json` markers that
the uncommitted `capture-owner.ts` work writes beside each capture directory.
That failure belongs to the capture-owner change and needs its helper filtered or
the marker moved; it was left untouched. Gates remain open; no push.

Checkpoint 2026-10-24 (parsed-file record reservation). Two Sol-medium developers and a
Luna reviewer; developers ran no tests. Change: ScopeRetentionStage gains
reserveParsedFileRecords(count), which validates a safe non-negative integer and
clamps to the record ceiling. While reserved room is still owed, every other family
sees the aggregate ceiling lowered by the remainder; parsed-file capture keeps the
full ceiling. The eleven copy-pasted aggregate comparisons now go through one
totalRetainedRecords getter and one recordCeilingReached helper, with each site's
reason and flow unchanged. parse-impl reserves totalParseable right after the stage
is built and releases the unused remainder when parsing finishes, which answers the
reviewer's over-reservation risk because totalParseable is only an upper bound.
Validation: tsc 0; ten scope-retention and workspace-input files, 542 tests
passed; disabling the reservation fails 8 of the 9 new tests. Real checkout:
519 of 539 TypeScript files are now retained, with 20 still refused as
unsupported-syntax. The ceiling is still fully used (100,000 records: 89,455 model
registrations, 7,148 calls, 2,878 graph nodes, 519 parsed files), so heritage,
assignments, bindings, exports, imports and relationships still retain nothing and
overall coverage stays incomplete (Rust 2561, Python 232 and JS 62 refused). The
next hard constraint is model registrations at 89 percent of the ceiling. Not packed
or installed. No push. seedReady stays false.

Checkpoint 2026-10-24 (registration filter for languages without a scope hook).
Measured first: all 89,455 retained model registrations were symbol.add events, and
88,362 of them came from .rs (79,640) and .py (8,722) files, whose providers have no
scope hook and are refused in coverage, so they could only spend the shared record
ceiling. Change: a pure shouldRetainRegistration decides from the event's file path
(top-level filePath or def.filePath; clear events, malformed input and unknown shapes
are always kept) and the parse-impl observer skips events whose provider lacks
emitScopeCaptures. A skipped event returns true on purpose, because returning false
makes the model stop observing and flag the family incomplete; the live model
mutation is untouched since only the retention observer is gated. Two Sol-medium
developers and a Luna reviewer; developers ran no tests. Validation: tsc 0; 16 files
and 653 tests passed; routing every event through the stage again fails the new
integration test. Real checkout: registrations fell from 89,455 to 685, but the
freed room went to calls, which grew from 7,148 to 95,918 of a 260,111-record demand,
so the 100,000 ceiling is still full and parsed files stay at 519 retained. Heritage,
assignments, bindings, exports, imports and relationships still retain nothing.
Reviewer note: no production consumer replays retained registrations today, and the
retained set is now provider-filtered, so the observed-registration-inputs evidence
must be read as the subset for languages with a scope hook. Next: calls from files
whose language has no scope hook are the same waste and need the same decision.
Not packed or installed. No push. seedReady stays false.

2026-10-24 retention filters and measurement: observed-input retention (calls,
heritage, assignments, constructor bindings, model registrations) and now graph
nodes/edges skip files whose language is known but has no scope hook, via
retainableByFile and createGraphRetentionFilter; the live graph is untouched.
Edges touching a dropped node are dropped. Real 7033-file ontocode checkout,
retention only: calls 95,918 -> 1,587 (98.5% were .rs/.py); graph nodes 10,620 ->
7,821 and relationships 86,275 -> 70,449; artifact 47.7 MB of 64 MiB; 519 TS files
retained, 20 TS and 62 JS refused unsupported-syntax, Rust 2,561 and Python 232
unsupported; status incomplete, seedReady false, ~39 s, 2.2 GB RSS. Remaining
ceiling pressure: exported-types now retains 18,273 records (2.1 MB) and
graph-node-record-byte-limit still fires, so graph families are still near the
100k record ceiling. Foreground validation: tsc exit 0; 22 files, 750 tests passed;
mutation removing the node/edge guards failed the integration test. Reviewer notes:
filtered retention makes observed-* evidence a subset for hooked languages; the
candidate reader does not cross-check auxiliary filePaths against the retained set
(existing gap); cross-language callee evidence is unproven; a retained file with no
export captures can read a value import of a type name as missing-export, so
revisit before seed admission. Nothing after the quarantine install is packed or
installed. No push, no cap change, no reindex.

2026-10-24 graphfilter candidate installed locally: tarball sha256 43e9c31e191a56e4f43628d26c0410603eccb9c1c34c541175616aeb24811e07 at /opt/d1/tmp/ontoindex-graphfilter-20261024-artifacts, installed at /home/er77/.local/opt/ontoindex-2.3.5-rc.12-graphfilter-20261024 (727/727 dist files byte-equal to the build; MCP handshake reports 2.3.5-rc.12 with the same 8 tools as the quarantine install). The connected MCP still points at the older core-20261023c path; eight-tool acceptance on this build is not run. No push.

2026-10-24 binding filter and graph-node diagnosis: file-bindings and exported-types retention now skip files with no scope hook (two guards in parse-impl.ts, retention only). Real 7033-file checkout: exported-types 18,273 -> 48 records, file-bindings 352 -> 23, total records 100,000 -> 81,450, artifact 45.6 MB. Two Sol-medium developers (source guard, integration test) and one Luna explorer used disjoint scopes; children ran nothing. Mutation removing both guards failed the new integration test. Foreground: tsc exit 0; 23 files, 751 tests passed. Root cause of graph-node-record-byte-limit, measured with a scratch dist probe (restored): not a code node but Markdown Section nodes - 2,867 Section nodes carry 8.7 MB of content (File 4,238 nodes 0.99 MB, Folder 721 nodes 0.11 MB); two exceed the 256 KiB record cap (.memory-bank/ONTOCODE_INTERNAL_CRATE_RENAME_TRACKING.md 459,452 B; .memory-bank/excel/AXEL_RC_CLOSED_EVIDENCE.md 274,638 B). The node loop breaks at the first failure, so every later node is dropped, and a continue-past-failure probe also tripped relationship, file-binding and exported-type byte limits and failed the candidate on byte limit, so skipping alone is not enough. Open decision (three options compared): (a) continue past oversize nodes and keep the family incomplete, cheapest and honest but not a fix; (b) exclude Section content from the retained node and let source-owned replacement regenerate Sections from Markdown, which needs a parity test because it changes the retained node shape; (c) raise maxRecordBytes, rejected as a cap increase that masks scope. Recommended: (b) behind a differential parity test. Not packed or installed after this slice; the installed graphfilter candidate predates the binding filter. No push, seedReady false.

2026-10-24 section filter and sectionfilter candidate: retained graph nodes now exclude Markdown Section nodes and their CONTAINS edges (createGraphRetentionFilter; the markdown phase regenerates Sections from source and runs before parse, confirmed from pipeline.ts and parse.ts deps; live graph untouched). On the real 7033-file checkout the Section nodes were 19,332 and every edge touching a Section is CONTAINS (19,332 of 26,978). Retention-only result: graph nodes 7,825 -> 5,911 (1.6 MB), relationships 70,449 -> 7,847 (2.9 MB), total records 81,450 -> 16,934, artifact 45.6 MB -> 6.9 MB, no graph-* issue (graph-node-record-byte-limit is gone), 31 s, 2.2 GB RSS; status still incomplete, seedReady false, remaining issues are unsupported/unsupported-syntax/missing-outcome/import-state-incomplete/skipped. Two Sol-medium developers (filter+unit, integration) and one Luna explorer, disjoint scopes, children ran nothing. Integration test first failed because it asserted graphNodesCaptured, which is false for any Markdown file (missing-outcome); the assertion was replaced by a no graph-* reasons check. Mutation disabling the Section drop failed the integration test. Foreground: tsc exit 0; 25 files, 800 tests passed. Packed and installed locally at /home/er77/.local/opt/ontoindex-2.3.5-rc.12-sectionfilter-20261024 (tarball sha256 aff86403670f005cf729f084f14cca86249d964e70d11d74fa9da4b12690eb25; 727/727 dist files equal to the build; handshake 2.3.5-rc.12, same 8 tools). Open caveat: the retained graph is now a subset (no Sections), so any future replay or seed admission must regenerate Sections from the markdown phase; the CONTAINS Section edges are not retained. Connected MCP still uses core-20261023c; eight-tool acceptance on this build not run. No push, no cap change, no reindex.

2026-10-24 coverage survey and shebang slice: the 82 TS/JS refusals on the 7033-file checkout are 54 reference-capture refusals (member calls on call/member/parenthesized receivers, 74+64+57 occurrences; chained calls and IIFEs, plus spread, super, import(), type queries) and 28 module-subset refusals (import-heavy files with expression statements, lexical declarations, hash_bang_line in 9, export clauses). Explorer finding: @reference.call.member without a receiver capture is not defaulted to free, but emitting free for a property name would bind to a same-named free function, and no capture kind represents a call on an unresolvable receiver, so chained member calls and IIFEs cannot be captured without a consumer change; refusal stays correct. Only the TypeScript provider defines emitScopeCaptures; Rust (2,561 files, 60.6 MB) and Python (318 files) have none. Shebang slice: a first-child hash_bang_line is skipped in emitTypeScriptCaptures and isTypeOnlyModule (isLeadingShebang; non-first or errored shebangs stay refused); 18 new cases in typescript-shebang.test.ts, one existing type-only fixture moved to a misplaced shebang; mutation failed 14 of 18. Real-checkout effect is small: parsed files 519 -> 520, extraction failures 82 -> 81, because most shebang files also use other unsupported constructs. Not packed or installed. Full-analysis baseline measured with graph phases on and worker pool: 41 s wall, 2.3 GB peak RSS, 117,648 nodes, 274,551 relationships (retention-only run 31 s, 2.2 GB). Two Sol-medium developers and two Luna explorers, disjoint scopes. Recommendation: the remaining TS/JS gap is a long tail of constructs each worth only a few files, so the next coverage investment is a Python declarations-and-imports hook (232 files) and then Rust, each with its own parity tests; no gate claimed. No push, seedReady false.

### Checkpoint 2026-10-24: open-time damage classification (openclass candidate)

Measured on real 8.8 MB native databases built with one bulk insert and CHECKPOINT. Truncation, or a 64 KiB flip at the midpoint or near the end, fails at open with a plain native message ("Reading past the end of the file", "Cannot read from file"). The earlier belief that these files open and fail at the first query was wrong for these sizes. The earlier in-flight design (a typed read error thrown from the pool and a new overlay marker reason) was removed after the test showed it could not trigger.

Shipped instead: `classifyLbugOpenError` in `src/core/lbug/open-error.ts` now classifies those two native read signatures as `corrupt` unless the message names the WAL or a lock, so the existing overlay quarantine fires for them. Tests: unit cases in `lbug-open-error-classifier.test.ts` and real-file `lbug-open-damage-real.test.ts`. Removing the new branch fails 4 of 6 real-file tests and 2 unit cases. Validation: tsc exit 0, 43 files and 1,631 tests passing in the foreground aggregate.

Unresolved native behavior, not fixed here: the driver opens some damaged files and then either segfaults the process (damage near the start of the data pages, measured at page offsets 16 and 32) or fails the first query with "Buffer manager exception: Unable to allocate memory". Both are outside JavaScript error handling, so no classifier can quarantine them in-process. Damage in the later data pages was read back as a successful query that silently lost rows. Quarantining these needs an integrity check before admission, which is a separate slice.

Candidate: `/home/er77/.local/opt/ontoindex-2.3.5-rc.12-openclass-20261024`, tarball SHA-256 b984dc02b5e17e030f80d444b341162a382e1c71b301477ef724caeb3f60c2d7, 727 of 727 dist files equal the build, handshake reports 2.3.5-rc.12 with 8 tools. The connected MCP is not repointed. No push. seedReady stays false and no gate is complete.

### Checkpoint 2026-10-24: overlay database integrity digest (digest candidate)

Closes the gap recorded in the openclass checkpoint. Damage that the native driver opens and then segfaults on, or reads back with silently lost rows, cannot be caught in JavaScript, so the check runs before any native open.

Shipped: `src/core/lbug/database-digest.ts` streams the overlay database file into SHA-256. `run-analyze.ts` records `databaseDigest { sha256, size }` in the published generation's base.json, computed after the strict close and before publication; source inspection found no database write between them. `computeSnapshot` in `backend-overlay.ts` rejects a malformed digest, a size mismatch or a hash mismatch with the reason "overlay database failed integrity check", after the base and HEAD checks and before the database is opened. A base.json without the field (an older generation) stays accepted. A successful check is memoized by device, inode, size and mtime, capped at 16 entries and cleared with the snapshot cache, so an immutable generation is hashed once per process.

Validation in the foreground: tsc exit 0; 50 files and 1,767 tests passing in the aggregate. Removing the hash comparison fails 3 of 18 gate tests and removing the size comparison fails 1. A real native database confirms the digest is unchanged by a read-only open, query and close, and differs for same-size damage at page 16. The real dirty-overlay build test asserts the recorded digest equals the file's actual hash.

Known limits: the memo trusts stat identity, so a byte flip that preserves size and mtime on an already verified generation is only caught after a restart. Generations built before this change carry no digest and get no protection until rebuilt. The cost of the first check is one sequential read of the file per generation per process, not yet measured on a large overlay. The committed (non-overlay) generation has no digest.

Candidate: `/home/er77/.local/opt/ontoindex-2.3.5-rc.12-digest-20261024`, tarball SHA-256 dd3aa78ba650e41846489a8ec5bf6a3289dcd36a6c30d7e843291a622edb9b03, 728 of 728 dist files equal the build. The connected MCP is not repointed. No push. seedReady stays false and no gate is complete.

### Checkpoint 2026-10-24: digest candidate acceptance over stdio

The digest candidate was started as its own MCP server over stdio against this repository and called once per public tool, all with committed reads: discover (tool_contract), search (semantic), inspect (context), impact (symbol), audit (verify_diff with empty scope), manage (ensure_fresh), docs (readiness) and refactor (safe_refactor, dry run). All eight returned results. Two earlier refactor attempts failed on caller errors: read_mode is not accepted by refactor, and the rename action requires new_name. Whether rename itself works was not tested.

Digest timing: a 512 MiB random file hashed in about 0.3 s per pass (1.5 to 1.7 GB/s, page cache warm), peak RSS about 110 MB. This is a warm-cache figure. A cold read is bounded by disk speed, and the largest real overlay generation was not measured.

This is a stdio run by this session, not the host connection. The connected MCP still runs the older build, so the host-side acceptance run is still open. It does not cover working-tree reads (workspace_too_large), stateful audit lifecycle, refactor apply, cancellation or publication rollback.

### Checkpoint 2026-10-24: candidate reader checks auxiliary evidence against retained files (gate 2, partial)

Before: `verifyScopeRetentionCandidate` validated each auxiliary record (calls, heritage, assignments, constructor bindings, exported types, file bindings) in isolation and never compared its file path with the inventory. A manifest claiming status `retained` could carry evidence for files that were not retained.

Now: when the manifest status is `retained`, every auxiliary record's file path must belong to an inventory entry whose status is `retained`, otherwise the reader fails with "auxiliary record file not retained". An `incomplete` candidate is checked exactly as before. The existing test that accepts auxiliary paths outside the inventory still passes because it builds an incomplete candidate.

Real checkout (7,033 files, measured): the candidate is `incomplete`, still persists and verifies, seedReady false. All 1,972 auxiliary records (calls 1,587, heritage 1, assignments 23, constructor bindings 290, exported types 48, file bindings 23) sit on files whose inventory status is failed with unsupported-syntax, none on a retained file, so the new rule has no effect on that candidate and would reject it if it claimed retained. This also means auxiliary evidence is currently attached to files that fail capture; the filter that drops records of files without a scope hook does not drop records of files that have a hook but fail capture. Whether those records should be dropped or kept is open and needs the replay consumer's requirements.

Graph relationships: 98 of 7,847 name an endpoint that is not a captured node (48 sources, 50 targets, for example EXTENDS to an unresolved class name and IMPLEMENTS to trait From). The reader accepts these by design, and an existing test asserts that. Not changed.

Validation in the foreground: tsc exit 0; 58 files and 2,260 tests passing in the aggregate; new file test/unit/scope-retention-candidate-auxiliary-paths.test.ts has 19 cases. Removing the check fails 12 of 19, and weakening it to inventory membership only fails 6.

Gate 2 stays partial: the reader still does not cross-check auxiliary scope ids or source ids against the parsed files, and the registration, import-state and graph families are checked only per record. No new install was built for this change, because the reader runs only in the opt-in retention path. seedReady stays false and no gate is complete. No push.

### Checkpoint 2026-10-24: publication rollback after late failure (gate 5, partial)

The existing overlay build test injected a failure only at the load phase, before the new generation had a base.json. Two new real-build tests cover the later boundaries, using the same fixture style (real repository, real native database, real publication):

- `dirty-overlay-publication-late-failure.test.ts` throws from the final progress callback, after the new generation's base.json (with its digest) is written and before CURRENT is renamed. It asserts the same error is rethrown, CURRENT bytes, the previous generation's database and base.json bytes and the overlay directory listing are unchanged, the capture directory is empty, and a retry publishes a new generation whose recorded digest equals the file's real hash.
- `dirty-overlay-digest-failure.test.ts` makes the digest step fail and asserts the same preservation, then recovery.

Mutation checks, each on its own: removing the new-generation cleanup in the catch block fails three tests (both new ones and the older one); making a digest failure silent fails the digest test. No production code changed in this slice. Validation in the foreground: tsc exit 0; 18 files and 593 tests passing in the aggregate.

Still untested for gate 5: process kill during publication, cancellation through the MCP path against a real build (an existing SDK test covers waiter cancellation), a failed CURRENT rename, and large-workspace performance.

Incident, resolved: /opt/d1 reached 0 bytes free during a mutation run. The write of src/core/run-analyze.ts was cut off and the file was left truncated, which made two mutation runs meaningless (they failed instantly with an empty log). The file was restored byte for byte from the backup taken before the run and verified with cmp, tsc passes, and the two mutants were then rerun successfully. Freed about 23 GB by removing five superseded local candidate installs (graphfilter, sectionfilter, quarantine, corruptfix, openclass) and their tarball directories; the connected MCP and the digest candidate were not touched. /opt/d1/tmp holds about 235 GB of older experiment directories that are not part of this work and were left alone. Lesson for future runs: check free space before any in-place source mutation and write mutants through a temporary file and rename.

No push. seedReady stays false and no gate is complete.

Checkpoint 2026-10-24 (capture-owner test repair): the 17 failures in
`workspace-capture-toctou.test.ts` came from tests that listed the
`capture-*.owner.json` marker files written by `capture-owner.ts`, not from the
refusal-diagnostics change. Options compared: (a) filter markers in the test
helper, (b) move the marker outside `workspace-inputs`, (c) drop the marker and
sweep by directory age. Chosen: (a). Option (b) changes a documented layout for
a test-only reason and the marker deliberately sits beside the capture root so
the root can be re-read as a repository; option (c) can delete a live capture
that is simply slow, which the owner pid check exists to prevent. The helper
`pendingCaptures` now returns only capture directories and throws if any marker
has no sibling directory, so a leaked marker fails loudly; the one assertion on
writes under `workspace-inputs` ignores `.owner.json` and still proves no capture
content is written there. Three lifecycle tests were added to
`capture-owner.test.ts`: the live marker is a private regular file with the
expected fields and is gone after dispose; a refused oversized capture leaves no
marker; a stale capture whose owner exited is reclaimed by the next capture.
Mutants (skip marker removal; skip the sweep) were each caught and restored.
Validation: 3 files and 119 tests pass, tsc exit 0, and 25 files touching
`analyze-delta`, `capture-owner` or `workspace-inputs` pass (481 tests, 1
expected fail). No source change. Gates remain open; no push.

Checkpoint 2026-10-24 (delivery candidate capture-20261024): built from the
current working tree with the repository build command (tsc exit 0, build exit 0,
`dist` rewritten at 09:28), packed with `npm pack` (tarball SHA-256
84ccb0dc938f8cf0086339500fe57c054980747b2f21803c9c524daf7eb6cbd8) and installed
with scripts disabled followed by `npm rebuild` at the install root into
`/home/er77/.local/opt/ontoindex-2.3.5-rc.12-capture-20261024` (497 MB; `/home`
sits on `/` with about 8 GB free, so the nearly full `/opt/d1` was not used).
728 of 728 `dist` JavaScript files equal the build; `capture-owner.js` and the
refusal-diagnostics message are present. A stdio handshake against the installed
copy reports serverInfo 2.3.5-rc.12 and the eight tools. Seven of eight tools
returned results (discover, search, inspect, impact, audit verify_diff, manage
ensure_fresh, docs readiness). `refactor rename` returned `no valid overlay
CURRENT generation`; the previous digest candidate returns the identical error for
the same request, so it reflects this repository having no dirty-overlay
generation, not the new build. This candidate adds the capture refusal diagnostics,
the capture-owner marker and sweep, the real-child cancellation test subject and
the auxiliary-path reader check; it is not the connected server: the connected MCP
still runs `core-20261023c` per `~/.ontocode/config.toml` line 46, which only the
operator may change, and host-side acceptance against this candidate has not been
run. No push, no tag, no release. Gates remain open.
