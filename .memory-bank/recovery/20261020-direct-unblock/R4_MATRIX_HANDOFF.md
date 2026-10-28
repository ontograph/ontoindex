# R4 qualification handoff

Date: 2026-10-20
Authority: Proceed all open tasks; direct acceptance recovery DECISION.md.

## Current state

Canonical IQ tracker: 46/49 DONE, selected IQ-12.
Canonical ADW tracker: 29/34 DONE, selected ADW-7f.
No default activation, publication, commits or user worktree creation occurred.
Four bounded Luna/Sol source-review packets completed; no live child agents.

Managed matrix `adw-iq12-matrix-20261020-r4`, PID2076410, unit
`ontoindex-adw-matrix-r4.service`, was launched once. Harvest this job; never
launch a replacement while its outcome is unknown. Last observation20:14 local:
size1cold12/20 completed,29285ms,1build; earlier20clean cold completed with zero
builds. No terminal receipt yet. Three canonical result observations and three
bounded log reads consumed; each log showed new sample progress. Further
observation requires terminal notification or changed evidence. Source
and compiled build remain frozen. Independent wrapper and checker are outside
the frozen directory. Six dirty cold groups ×20samples at roughly25s each alone
take about50minutes; allow additional warm/baseline/setup/cleanup time.

Canonical harvest from ontoindex/:

```sh
env ONTOCODE_COMPILER_ARTIFACT_ROOT=/opt/d2/.ontocode/artifacts/compiler-lane /home/er77/.cargo/bin/just --justfile /opt/d1/_wrk/ontocode/justfile lane-result adw-iq12-matrix-20261020-r4
```

## Accepted current evidence

- IQ-11D: managed adw-iq11d-20261020-r4 exit0, build0/full-off0;
  662files11973tests pass,1expectedfail311skips,607.79s. Final freeze0.
- IQ-11B: managed adw-iq11b-20261020-r4 exit0; identical counts,596.32s.
  Eleven skip-bearing files unchanged. No unhandled/native allocation failure;
  mock-backend disposal diagnostics match full-off and are retained.
- IQ-11: managed adw-iq11-sdk-20261020-r4 exit0;23tests4files30.28s,
  TypeScript0; compiled replay29records15SDK6CLI requests,6mutation identities,
  all-owned-descendant cleanup83.105ms exit0. Replay SHA
  5ef653ceeff550460b596be6eb43406272b2578488c02265d44e107805caae11.
- IQ-12A/ADW-7d: pilot adw-iq12a-pilot-20261020-r4 exit0,56324ms;
  size1cold26034ms, sampled2526928896B RSS,41.27CPU-s,1build,
  54.52ms cleanup. Independent raw/metric check0. Artifact SHA
  bdde97c314334225398dd9edf8aadaf3713068ee8a260298ece4f74a2a680e53.
- IQ-12A: functional adw-iq12a-functional-20261020-r4 exit0,220358ms;
  12groups13samples+2clean baselines, all budgets pass. Worst warm333.75ms,
  dirty cold25891.14ms, RSS2504855552B, warmCPU0.490976s, cleanup78ms;
  contention1generation, parity0differences. Independent checker0. SHA
  2b406b28169f782002d57e8016011ea75d07f8369122cacd1696dc562209fb73.
- ADW-7e accepts the full/compiled SDK/TypeScript correctness evidence.

Freeze directory: .ontoindex/adw-validation/qualification-20261020-r4/.
HEAD acbcb63830cf51a8fc0537a76f4267e5be758167.
Candidate inventory SHA6a6b4f015b7e1e18913958696e020f2edc3ff7218e3020da1d6acbd183c5670f.
Build inventory SHA32942fe0f3071fa38f6e2b9cadc426e21d8624e53a06c641d272676e03ace5c7.
Freeze includes its harness and rechecks HEAD. Do not add/edit scripts there.

The existing mcp-workspace-mutations-sdk.test.ts187–258 proves changed imports,
config, parse metadata and same-byte added-caller/deleted-edge full-analysis
parity. A preliminary four-file-only gap observation was superseded; no extra
proof harness or source edit is needed.

## Remaining acceptance

1. Harvest matrix terminal result. Its wrapper verifies freeze before/after,
   calls the existing instrument, then independent check-benchmark.mjs. Inspect
   raw diagnostics, frozen identities and budget extrema before acceptance.
2. Require exactly12groups;20samples/group except40contention client samples
   for20rounds; clean baselines20each; reference parity record present. All raw
   request/response/stderr/CPU records must exist. Checker reuses summarize and
   evaluateBudgets, recalculates summaries/verdicts and checks evidence shapes.
3. Accept IQ-12 and ADW-7f through complete-local with current revisions.
   Record compact evidence only: IQ tracker has about3KiB headroom.
4. IQ-13A/IQ-13 contract/handoff and ADW-8 documentation/readiness, followed by
   ADW-8a default predicate, ADW-8b ordinary compiled startup/TypeScript,
   ADW-8c final closeout. All required null local role scaffolds now exist.
5. Validate both trackers and scoped diff after final edits. Preserve unrelated
   dirty files. No publication is authorized.

Matrix gates remain warm p95<=1s; dirtycold p95<=55s; clean overhead<=max100ms,
25%baseline; RSS<=4GiB; coldCPU<=300s/warmCPU<=1s; artifacts<=2GiB;
cleanup<=5s; clean/warm0builds; contention1generation/round. Warm CPU requires
terminal cgroup interval through empty-scope shutdown. RSS sampled, OS caches
not flushed; generation count does not directly observe lock exclusivity.

Execution accounting: three build/full-off starts (r2failed,r3pass,r4pass),
two full-on starts (r3failed,r4pass), correction rounds2 consumed/final;
one r4 compiled SDK, pilot, functional and matrix start each. Prior historical
qualification remains immutable. Further failure permits diagnosis/retention,
not a blind rerun or another correction round. Loop protection survives resume.

## Prepared files and safe compaction

.ontoindex/adw-validation/review-20261020-r4/check-benchmark.mjs SHA
6c42104a8b3ee84e08418d37156dd1fd94692fb20c9efa424133f0e9f0b5738e.
qualify-matrix.sh SHA
3fc50f13dbe8fd1513489c8fa9fc5619fd07f9288b1172c92180e6315cdd597a.
The checker passed pilot and functional artifacts; the matrix wrapper is running.
The helpers are evidence tools, not product changes. ADW_DOCUMENTATION_DRAFT.md
is prepared for ADW-8 and must be reconciled with accepted matrix/default state
before applying to the README and knowledge-hub reference.

Exact completed IQ-0 preparation moved to IQ_COMPLETED_PREPARATION_HANDOFF.md.
Appending one section-separator newline reconstructs section SHA
12495e89a8c691db28892faac6b1872daea8ab24bf42fddcef455d3540ed1119;
replacing the link reconstructs pre-compaction whole-tracker SHA
475e2fc7f01c169a3b931b6ee8757003532363d877215ee04ced3b20aeb369b3.
Tool-owned manager block was untouched by that compaction. Final parser checks
pass for49IQ/34ADW tasks; git diff --check0.

## Activation implementation packet after gates

Three alternatives compared/challenged twice: one uncached predicate in existing
backend-overlay owner; runtime-only flip; global environment normalization.
Select shared predicate; runtime-only misses routing/cache/cursor consumers,
global normalization mutates process environment and obscures explicit rollback.
Absent or exact1 enables; exact0/empty/other values remain disabled. Keep uncached
so test and operator environment changes do not retain stale activation state.

Parent source scan confirms28literal checks in11declared production consumers.
Replace them using isAutomaticWorkspaceEnabled in existing backend-overlay.ts;
add imports to server/resources and extend existing imports elsewhere. Preserve
mutation guard and API shapes. Benchmark flagOff must explicitly set0 instead
of deleting variable. Unit tests cover actual absent variable by deletion,1,0,
empty and invalid values; existing config test labels undefined as empty, fix
its label and add a real absence assertion. Assert benchmark child env is0.

OntoIndex is commit-fresh but dirty files absent graph. Bounded activation
symbol impacts resolved identities but returned UNKNOWN0counts; source is
authority for unavailable attribution. Earlier getOverlaySnapshot impact MEDIUM
10direct nodes; includes CLI status and mutation guard. No production edits yet.
Do not reindex for dirty state alone. Reuse recorded impact responses if unchanged.

README and knowledge-hub reference currently describe obsolete committed-only
resources, live fallback/timestamp checks and capped50-file automatic behavior.
After acceptance, document automatic request preparation, content/config/HEAD
verification, immutable generation reuse/pins, full relationship graphs,
typed preparation failure without stale success, lexical/vector limits,
independent per-repo group snapshots, bound logical cursors and byte-page replay,
no committed publication, measured costs and sampled-accounting caveats.
The knowledge-hub file is ordinary reference Markdown, not a KM package/store.
Update ADR activation table runtime-only wording to match shared predicate scope
when ADW-8a is prepared. ADW-8b uses ONTOINDEX_ADW_REPLAY_DEFAULT=1 and
ONTOINDEX_ADW_REPLAY_CLI=dist/cli/index.js; rebuild compiled candidate after switch
before ordinary startup proof. Required6-file focused tests+TypeScript and
guard coverage must match actual changed consumers.

knowledge_handoff: none; existing autopilot and manager rules already require
terminal receipts, bounded observation and reuse of unchanged evidence.
