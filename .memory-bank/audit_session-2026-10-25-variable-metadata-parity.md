# Sequential variable metadata parity

Date: 2026-10-25

Sequential parsing now invokes the existing variable extractor with the same
Const/Static/Variable guards as the worker. Type, visibility, static/const/mutable
flags and scope reach graph nodes before merge; declared type also reaches the
symbol table. Existing property extraction remains intact.

Compared guarded existing-extractor reuse, removing worker metadata, and
post-parse normalization. Selected reuse after independent second review: it
preserves metadata without a second parsing pass or another extraction owner.
Review caught the need to enrich before merging and preserve symbol-table types.

The ORM replay fixture again includes ambient const declarations, plus ambient
let and an ordinary exported const. Independent expected-value assertions cover
live and persisted nodes; complete graph comparisons cover sequential, actual
worker and controlled worker-failure recovery modes. Unsupported nested ORM scope
syntax still produces incomplete evidence; seedReady remains false.

Validation from ontoindex/, native Linux, serialized:

- `ONTOINDEX_MAX_WORKERS=4 npm run build`: exit 0.
- `ONTOINDEX_TEST_WORKERS=4 node node_modules/vitest/vitest.mjs run test/integration/scope-retention-orm-replay-parity.test.ts test/unit/variable-extraction.test.ts test/integration/scope-retention-replay-parity.test.ts test/integration/scope-retention-replay-edit-differential.test.ts test/integration/parse-fallback.test.ts --maxWorkers=1 --testNamePattern='^(?!.*Ruby)'`:
  exit 0, five suites, 97 passed and two Ruby cases skipped, 22.20 seconds.
- Scoped tracked-source whitespace check: exit 0.
- OntoIndex committed impact: LOW, one direct caller. Workspace navigation
  exceeded 1832/1600 files; current source is authority. Bounded verify_diff
  passed supplied file scope; expected symbol scope was not checked.

Four read-only Luna/Sol agents and two Sol developers participated; independent
source review found no issues. Two development packets initially lacked strict
validation wording and were corrected before edits. One build and one suite
invocation ran; no detached jobs, installation, deployment or full-suite claim.
An initial file-read command used package-relative paths from the wrong directory;
the reads were corrected, and its separately launched build completed successfully.

Remaining: nested-call scope support, other retained extraction families,
source/model-pack identity, replay admission/activation and runtime/performance
acceptance. Export-declare wrapper visibility is a separate unverified concern.
The structured tracker remains closed; this bounded conversational successor
does not admit replay seeds or close the broader project.
