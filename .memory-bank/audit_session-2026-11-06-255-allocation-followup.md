# 2.5.5 allocation follow-up

Date: 2026-11-06

Current outcome: the reproduced citation failure is fixed at the default
64 MiB budget; 53 focused tests pass. Earlier experiments below record the
investigation chronology. Full qualification remains outstanding.

## Evidence

The historical qualification at `/opt/d2/ontoindex-255-full-ZDqaqenL`
recorded four buffer-pool allocation failures in `self-index.log`, despite
19 passing self-index tests. It did not record the memory or outstanding-query
state needed to attribute the native refusal.

Four read-only Luna/Sol reviewers checked query lifetime, enrichment queries,
historical evidence, and the current failure-handling diff. No missing pooled
result cleanup or material defect in the scoped diff was established. Committed
OntoIndex evidence excludes dirty code; current source is authoritative for it.

One new reproduction used the preserved snapshot's installed Vitest to run
`test/integration/super-functions.test.ts`, with its original `TMPDIR`,
`ONTOINDEX_HOME`, extension directory and two test workers. Exit 0: 19 tests
passed in 21.72 seconds; captured output contained no allocation errors.
No product build or reindex was run. This is a new observation, not a replacement
for the historical qualification. Original system pressure was not recreated.

At reproduction startup, neither `ONTOINDEX_LBUG_BUFFER_MB` nor
`ONTOINDEX_LBUG_POOL_SIZE` was set. Source defaults are 64 MiB for committed
databases and two pool connections. The current session cgroup reported
`memory.max=max` and zero OOM events; these observations do not establish the
historical environment or exclude native buffer exhaustion.

## Decision

Three candidate remedies were challenged:

- Reduce query working sets: potentially lowers allocation demand, but chunking
  increases queries and cannot guarantee relief for one high-fan-in target.
- Reduce query concurrency: existing pool configuration provides a reversible
  experiment; permanent serialization costs latency and cannot fix a query
  that exceeds the buffer alone.
- Increase the buffer budget: existing configuration supports it, but raises
  memory use per open database and could mask an unidentified query defect.

Retain the current bounded resource-error fallback and partial-result warnings.
Current-source acceptance now rejects enrichment and query failures and requires
nonempty search results. The earlier shape-only assertions did not establish
successful search. Explicit committed reads use the canonical registry ID;
the display ID did not activate the committed-read context.

With those stronger assertions, the default 64 MiB run failed four of nineteen
self-index tests with citation-lookup buffer exhaustion (session 18024).
A single-connection run failed the same targeted case (session 14938).
The targeted case passed at 128 MiB (session 71254), and the complete
`super-functions.test.ts` and `backend-search-symbol-lookup-real.test.ts`
comparison passed all 24 tests in 19.85 seconds (session 14553, exit 0):

```sh
ONTOINDEX_LBUG_BUFFER_MB=128 ONTOINDEX_TEST_WORKERS=2 \
./node_modules/.bin/vitest run test/integration/super-functions.test.ts \
test/integration/backend-search-symbol-lookup-real.test.ts
```

Run from `ontoindex/`. The 128 MiB override is a measured workaround for this
graph. Default-budget acceptance remains open; the native allocation cause is
not fully established. Do not raise the default based on one graph. A proposed
single-match citation rewrite was rejected because it returns every caller,
breaking the existing one-row-per-target bound and increasing transfer and sort
cost for high-fan-in targets. Permanent serialization also lacks supporting
evidence after the single-connection failure.

The selected small fixes preserve rename symbol UID, reject failed or ambiguous
rename previews before apply, and restrict compiler-baseline suppression to
recognized source extensions. The rename unit suite passed 31 tests. Retention
test wording now accurately describes publication coverage. No new scheduler,
dependency, or parallel query owner was introduced.

The preceding current-source validation passed 206 focused unit tests and 24
integration tests, TypeScript checking, formatting, shell syntax and diff checks.
ESLint exited 0 with 71 warnings. No release, installation or full qualification
is claimed. The unrelated GN manager state is unchanged.

Final checks after the committed-context correction: TypeScript test-project
checking, scoped Prettier, shell syntax and `git diff --check` exited 0.
OntoIndex `verify_diff` passed the explicit file scope; expected symbols and
executed tests were not supplied, so that result establishes neither symbol
scope nor test coverage. A package-local Prettier invocation was unavailable;
the existing root installation performed the successful formatting check.

Remaining work: isolate a memory-bounded citation query that succeeds at 64 MiB
without increasing raw result cardinality, then rerun the affected
acceptance cases at the default budget. The root tooling clean install passed
earlier, but backend clean-install and full qualification are not established.

## Follow-up experiment

Four Luna/Sol reviewers assessed query selection, native acceptance, fixture
identity and failure attribution. Source inspection corrected the earlier
description: the second relationship match already specifies `CodeRelation`;
its endpoint nodes are unlabeled.

A candidate replaced the second edge match with two scalar minima: minimum
eligible caller ID and minimum caller ID having a CALLS edge. Their equality
selects CALLS; otherwise the chosen caller has IMPORTS. A node-only lookup
preserves caller fields and the one-row-per-target bound. This avoids returning
all callers or adding per-target queries, but logical bounds do not prove the
native allocation requirement.

At 64 MiB, the candidate passed 49 tests but failed the same four self-index
cases (session 95326, exit 1, 20.19 seconds). The command selected
`backend-search-symbol-lookup-real.test.ts`, `super-functions.test.ts`, and
`backend-search-symbol-lookup-batch.test.ts`, with two test workers. The candidate
was reverted because it did not fix the reproduced failure. No default budget
or production query change is retained from this experiment. Do not repeat this
candidate unchanged; the next query experiment requires native plan evidence
for the exact failing batch.

The self-index fixture now verifies canonical checkout/storage paths and the
active database's real path, and uses its resolved generation ID in committed
context instead of a filesystem path. This reuses the production resolver.
Validation after that correction: 19 self-index tests passed at 128 MiB
(session 98342, exit 0, 17.43 seconds); TypeScript test-project checking exited
0 (session 67618). Bounded OntoIndex file-scope verification passed. This does
not close default-budget acceptance. The retired GN tracker returned
`no-dispatch`; its state was left unchanged because this follow-up is a separate
user-authorized issue investigation.

## Plan-guided resolution

Four additional Luna/Sol reviewers challenged the native plan, buffer owner,
fixture and acceptance assertions. A temporary spy captured the exact 50-target
citation batch and native EXPLAIN output on generation
`1793951700753-51446-6wyi17gg7hi`. Evidence is stored locally in
`/tmp/ontoindex-citation-plan-20261106.json` and the matching `.log` file.
The instrumented original query reproduced the 64 MiB failure (session 61648,
exit 1). The spy was removed after capture.

The original plan's first branch filters by `$nodeIds`; the second relationship
branch lacks that predicate before its hash-build subtree. Three remedies were
compared: repeat the target predicate on that branch, partition by node label,
or raise the native memory budget. The repeated predicate preserves selection,
one-row-per-target output and query count without additional infrastructure.
Partitioning adds multiple queries and label handling; a higher budget increases
per-database memory without addressing the observed plan shape.

Added `n.id IN $nodeIds` to the second relationship-match WHERE clause. The
previously failing targeted case passed at 64 MiB (session 73092, exit 0).
The full focused selection then passed 53 tests in 15.34 seconds (session 2581,
exit 0):

```sh
ONTOINDEX_LBUG_BUFFER_MB=64 ONTOINDEX_TEST_WORKERS=2 \
./node_modules/.bin/vitest run test/integration/super-functions.test.ts \
test/integration/backend-search-symbol-lookup-real.test.ts \
test/unit/backend-search-symbol-lookup-batch.test.ts
```

This establishes resolution of the reproduced failure, not a universal memory
bound or measured native operator allocation. No post-change plan was captured.
The default memory budget remains unchanged.

Also corrected two review findings: native row-bound assertions now select
community/citation queries independently of aggregation syntax, and the fixture
uses `readActiveGenerationMeta` with the production legacy-index fallback.
Its comment no longer claims the committed context pins a generation. Concurrent
generation activation remains outside this fixture's consistency guarantee.
Bounded OntoIndex file-scope verification passed; it is not test evidence.

## Missed regression coverage

Added a real File IMPORTS caller that sorts before a Method CALLS caller;
the native fixture verifies caller-ID ordering takes priority over edge type
and supports callers from different labels. Native row-bound checks now require
both lookup batches and the high-fan-in target, avoiding empty/vacuous success.
The unit suite checks both citation target predicates and verifies that empty
optional enrichment preserves all process symbols.

Native fixture: 5 tests passed at 64 MiB (session 35201, exit 0). Batch unit
suite: 29 tests passed (session 83188, exit 0). The self-index fixture also
compares trusted metadata identity at teardown and closes the pool in finally.
This detects a changed ending generation, including regeneration at the same
commit; it does not claim protection against an A-to-B-to-A activation.
No additional production behavior change was required by this review.
Self-index suite after the teardown guard: 19 tests passed at 64 MiB
(session 76167, exit 0). Final TypeScript checking exited 0 (session 92250).
The 5 native, 29 unit and 19 self-index tests total 53 passing tests across
three serial invocations. OntoIndex file-scope verification passed.

## Final delta review and ambiguity repair

Four bounded GPT reviewers checked query semantics, self-index fixture handling,
rename behavior and qualification reconciliation. Review found a missed rename
ambiguity: fuzzy resolution selected the first candidate before passing an exact
UID to the atomic rename owner. The existing resolver now rejects distinct
same-name candidates with an instruction to provide a canonical UID. This
protects rename, modify-body, extract and move before preview or writes.

Compared three fixes: guard the existing resolver, replace it with the shared
resolver, or require UIDs for every request. The guard preserves unique-name
compatibility and database error handling without extra queries or dependencies.
Second review confirmed that the ambiguity error must escape the database-error
catch. Explicit UID requests retain their existing behavior. Independent source
review accepted the resulting guard and tests.

Fresh native validation, with no product build:

- Eleven affected unit suites: 326 passes, exit 0, session 42818. Covered typed
  search, overlay merge, resource classification, pool lifecycle, rename,
  explore, retention and precommit behavior.
- After the ambiguity fix: safe-refactor, backend-rename, search-replay and
  failed-open-retry suites: 64 passes, exit 0, session 58217.
- Test-source TypeScript check: exit 0, session 60840.
- Self-index selection `gnExplore|dryRun:true returns preview`: 5 passes,
  14 filtered skips, exit 0, session 35318, 64 MiB buffer.
- Bounded OntoIndex verify_diff passed for the two edited code/test paths;
  its executedTests list was empty and is not execution evidence.

Three serial test invocations and one typecheck were completed. Three worker
dispatch attempts were rejected before execution for prompt-shape requirements;
the coordinator applied the bounded fix locally after four review agents had
completed their scopes. No worker was started by those rejected attempts.

Full final-source qualification and backend clean-install proof remain open.
Historical full-suite results must not be transferred to this dirty checkout.
Generation identity is checked at fixture boundaries; it is not a pinned-reader
guarantee. A larger default buffer, second reader, permanent serialization and
new query infrastructure are unnecessary for the reproduced issue.
