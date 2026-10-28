# Capture blocker review

Date: 2026-10-25
Status: bounded fixes implemented and focused validation passed; representative replay qualification remains open.

The retained shared-component qualification failed. Its three independent
blockers are parser/discovery inventory conflation, unsupported TypeScript
syntax, and differing community output. The current committed graph matches
HEAD `2623820ec85113c28b238d5f72dde496e27426a1`; dirty source remains authoritative.

## Review

Good: the benchmark preserves failed evidence, checks actual replay mode and
input identities, and refuses incomplete candidates. Isolated source inputs
avoid mutating the live repository index. RSS observations expose scan failures.

Weak: passing tiny fixtures did not establish component coverage. Discovery
files and parser inputs were treated as the same domain. A fixed Leiden seed
did not control graph insertion order. No accepted performance gain exists.

Open: graph equality currently compares IDs and typed edges, not all properties.
The remaining unsupported TypeScript constructs need individual classification.
Required-language Linux, public CLI/MCP, installation and representative-scale
qualification remain separate acceptance work. The pinned external workload is
absent. The historical structured manager remains closed.

## Decisions after two-pass challenge

| Issue | Alternatives | Selected approach and limits |
| --- | --- | --- |
| Inventory | Filter non-parser paths; add non-parser retention status; separate discovery evidence | Separate discovery identity from parser inventory in the existing manifest. Preserve configuration identity and unsupported-source refusal; reject older candidate versions. Filtering alone loses structural identity; a new inventory status complicates parser completeness. |
| TypeScript | Narrow erased-syntax extension; full interface type semantics; accept arbitrary valid syntax | Admit direct exported interfaces through the existing erased-module gate, retaining lexical interface scopes. Full type semantics is broader; arbitrary syntax would conceal missing facts. Mixed runtime files remain refused. |
| Communities | Canonical graph construction; alter Leiden traversal; replace clustering | Sort eligible nodes and canonical undirected edges before seeded Leiden. Preserve filters and clustering semantics; test insertion permutations. Vendor edits add maintenance risk; replacing clustering changes output semantics. |

Parent owns serial validation. Declared allowance: one native build, one focused
suite, up to two correction suite runs with diagnosed changed causes, and one
frozen-workload pair using a new evidence destination. Children perform source
edits only. Four discovery packets completed or harvesting; three disjoint GPT
implementation packets cover inventory, TypeScript and communities.

## Validation

Native build session 61935 exited 0. First focused suite session 60734 exited 1:
999 passed, 10 failed across 18 files. Log:
`/opt/d1/tmp/ontoindex-capture-blockers-tests.log`. Failures are stale complete-input
fixtures without discovery evidence and a version-tampering test assigning the
now-valid version 5. Correction round one updates those fixtures.

Independent review identified another consumed input: `ontoindex-packs` can
change ORM extraction outside parser/configuration evidence. Compared capturing
pack bytes, comparing effective ORM settings, and refusing replay for existing
pack roots. Selected conservative filesystem checks at capture and admission;
ignored paths and symlinks must also refuse. This source correction requires one
additional build under the user's authorization to fix discovered issues: build
allowance amended from one to two, one consumed. Test allowance unchanged.

## Final evidence

Final native build session 35005 exited 0. Corrected focused suite session 13801
exited 0: 1,013 tests across 18 suites passed in 80.10 seconds. Saved log:
`/opt/d1/tmp/ontoindex-capture-blockers-tests-r1.log`. The earlier failed run is
retained. Missing source-map warnings were nonfatal. This is focused validation,
not a complete repository or required-language qualification run.

Implemented manifest version 5 with independent discovery evidence and parser
inventory; older versions are refused. Added direct exported-interface support
within the erased-only TypeScript gate. Canonicalized community node and edge
insertion, including reciprocal-edge deduplication. The sorting adds
O(V log V + E log E) time and O(V+E) temporary storage; downstream Leiden caps do
not bound graph-construction cost.

Analysis-pack roots now refuse replay at capture and admission. Only ENOENT
establishes absence; directories, files, dangling symlinks and other errors
refuse. Capture preserves the unsupported-input issue even if the root is later
removed. Checks before and after observation do not establish an adversarial
atomic filesystem snapshot. Full parsing remains available.

Compiled emitter classification of the unchanged frozen fixture accepted 12 of
41 TypeScript files and refused 29, an increase of 11 accepted files. Each source
hash was checked before parsing. Evidence:
`../eval/results/ontoindex-shared-pair-87x1w40f/capture-classification-02.json`.
This establishes emitter coverage only. No representative pair was rerun and no
replay speed or memory improvement is established.

Final OntoIndex scoped `verify_diff` returned PASS for the seven production
paths. It capped impact scanning at 25 symbols and did not check symbol scope
because expectedSymbols was omitted. HEAD and indexed commit match; 437 dirty
files are not fully represented by that graph. Source inspection is authority
for the edits. Final whitespace validation is recorded by the closing session.

Validation budget used: two builds, initial suite plus one correction suite,
zero representative pairs. Bounded compiled classification substituted for the
known-incomplete pair: first launch failed on an unsupported Tree.delete cleanup
call, second launch passed after removing that call. No failed launch produced
accepted evidence. Four discovery packets and three disjoint implementation
packets fulfilled delegation; independent review supplied the pack-input guard.

## Remaining acceptance work

1. Extend the existing capture owner for the 29 refused runtime/mixed-syntax
   files, preserving refusal until producer facts and parity are established.
2. Then run a frozen representative full/capture/replay pair that proves actual
   replay execution before comparing timing or RSS. Current graph comparison
   proves topology only, not equality of all properties.
3. Qualify public CLI/MCP reuse, required JavaScript/TypeScript/Python/C++/Rust
   behavior on Linux, and isolated installation before default activation.
4. Preserve RSS scan failure causes and distinguish component maxima from
   simultaneous process-tree peaks when interpreting benchmark evidence.

The pinned external whole-graph workload remains absent. Kotlin, Dart, Ruby and
Windows remain deferred. Historical structured manager state remains closed;
this report creates no lease, receipt, or new completion claim for that manager.
