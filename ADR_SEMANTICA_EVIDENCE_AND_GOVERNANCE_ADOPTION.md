# ADR: Semantica-Inspired Evidence and Governance Adoption Boundaries

Status: Proposed, revised after architecture challenge
Owner: OntoIndex maintainers
Date: 2026-08-11
Depends on: `ADR_STRUCTURAL_CONFORMANCE_AND_EVAL_ORACLES.md`, `ADR_SOURCE_SNAPSHOT_GATED_GRAPH_AUTHORITY.md`

This ADR reverses no decision in either dependency. It constrains new work to their
existing owners and vocabularies. If a slice later requires changing a decision in
those ADRs, that slice must amend the owning ADR explicitly rather than rely on this
one.

## Context

Semantica was reviewed as a design donor for OntoIndex. Seven concepts scored above `4/10` for OntoIndex fit:

| Capability | Fit |
| --- | ---: |
| Conflict-aware multi-source truth | 10/10 |
| Audit-grade provenance | 9/10 |
| Bi-temporal knowledge | 9/10 |
| Decisions as first-class graph objects | 7/10 |
| Ontology governance | 7/10 |
| Causal tracing and policy governance | 6/10 |
| Provenance-preserving deduplication | 5/10 |

OntoIndex already has domain-specific foundations for most of these ideas:

- graph facts carry confidence and extracted, inferred, or ambiguous provenance;
- symbol resolution retains weighted evidence;
- audit findings have verified and negative evidence, status transitions, tombstones, bundles, replay, and event-derived projections;
- retrieval preserves reciprocal-rank-fusion traces;
- docs enrichment traces requirements and API drift;
- semantic contracts and structural oracles validate bounded quality rules;
- immutable index generations bind graph authority to a source manifest rather than to commit identity alone.

The useful gaps are narrower than the donor concepts suggest:

1. OntoIndex does not have one precise contract for contradictory normalized claims.
2. Persisted audit events do not detect interior mutation or reordering.
3. Persisted evidence does not consistently state which source snapshot it describes and when OntoIndex observed it.

The remaining concepts are extensions of existing owners, not independent subsystems.

## Decision

Use Semantica only as a design reference. Do not add a Semantica dependency, general knowledge-graph platform, decision graph, policy engine, or entity-merging subsystem.

This ADR adopts three bounded directions, each requiring its own implementation design and acceptance gate:

1. normalized evidence-conflict reporting;
2. snapshot-scoped historical evidence;
3. bounded integrity verification for persisted audit events.

It also records four amendment boundaries:

- repository quality questions extend existing semantic contracts or structural oracles;
- audit decision explanations are projections over existing events;
- causal explanations traverse existing evidence and graph edges;
- evidence fusion extends existing resolution and RRF traces only where fields are demonstrably lost.

No item is blocked on another. Implemented and deferred states must be tracked per item; this umbrella ADR has no all-or-nothing completion state.

## 1. Normalized Evidence Conflicts

Add a common representation only when two or more claims have:

- the same versioned canonical fact key;
- values normalized by the owner of that fact family;
- values declared mutually incompatible by that fact family's comparison rule.

A conflict key must identify the fact family, canonical subject, predicate, comparison scope, and schema version. Producers must not infer conflict merely because candidates, confidence values, freshness states, or authorities differ.

The record must include:

- canonical conflict key and fact-family version;
- competing normalized claims and their original representations;
- source, authority, confidence, freshness, and snapshot identity for each claim;
- conflict class: `contradictory-value`, `authority-disagreement`, or `freshness-disagreement`;
- status: `unresolved`, `authority-selected`, `manual`, or `superseded`;
- selected claim when resolved;
- deterministic resolution reason code;
- bounded supporting citations.

Candidate ambiguity remains an existing resolution outcome and is not automatically a conflict. An ambiguous symbol lookup becomes a conflict only if the fact-family owner proves that the candidates assert incompatible values for the same canonical fact key.

The first producer must be one existing fact family with a concrete hidden-winner problem. Docs-to-code route or requirement resolution is the preferred starting point because it already exposes normalized identities, authority, freshness, and ambiguity. Do not add four producers at once or scan the full graph for hypothetical contradictions.

Automatic resolution may select a claim only when an existing authority or freshness policy produces one unique winner. Otherwise the conflict remains explicit and unresolved.

## 2. Snapshot-Scoped Historical Evidence

Generalize audit freshness into snapshot-scoped evidence validity. Do not model Git history as a global interval between `validFromCommit` and `validUntilCommit`: Git is a DAG, and those fields are ambiguous across branches, merges, cherry-picks, rebases, and dirty worktrees.

Historical evidence must identify the source snapshot it describes using the existing authority model where available:

- `targetHead`;
- `graphGenerationId`;
- `graphManifestDigest`;
- `coverage`;
- `snapshotMode`;
- `observedAt`;
- optional `introducedByCommit` and `removedByCommit` as provenance hints, not interval boundaries;
- optional `supersedesFactId`.

Reuse the field names already published by `CapabilityResponseFreshness` and
`resolveGraphAuthority` instead of inventing near-synonyms. `sourceManifestDigest` is
the existing function that computes the digest; the published field is
`graphManifestDigest`.

`coverage` is required, not optional. Manifest equality alone does not prove that the
requested evidence was covered: `manifestsMatch` compares source, scope, profile, and
analyzer-contract identity without comparing coverage, so a fact that omits coverage
cannot state whether its own family was fully analyzed at that snapshot.

Validity is evaluated relative to a requested snapshot or ref. A fact is applicable only when its source identity matches that snapshot directly or a fact-family-specific Git ancestry rule proves applicability. The response must state the requested ref, resolved commit, snapshot mode, and authority result.

`observedAt` describes when OntoIndex learned the fact. It does not prove when the fact first became true in source history.

The first slice applies to one externally persisted evidence family. Existing graph-diff and Git-object mechanisms remain the source of historical reconstruction. OntoIndex must not retain a complete graph copy for every commit.

This section amends `ADR_SOURCE_SNAPSHOT_GATED_GRAPH_AUTHORITY.md`; it must reuse that ADR's generation, source-manifest, coverage, and authority vocabulary rather than create a parallel freshness framework.

## 3. Bounded Audit Event Integrity

Add integrity checks to persisted audit events to detect interior mutation, insertion, or reordering:

- monotonic `sequence`;
- `previousChecksum`;
- `checksum` computed with SHA-256 over versioned canonical JSON excluding `checksum` itself.

The implementation design must define:

- canonical JSON rules and integrity-contract version;
- genesis `previousChecksum` value;
- whether store or event metadata participates in the checksum;
- schema-v1 handling: a legacy store is read-only. It reports `LEGACY_UNVERIFIED`, remains available for inspection and export, and refuses appends. It is never migrated in place, because rewriting unverified events would sign history the chain never covered. The corrective path is acknowledged archive-and-reset followed by re-ingest;
- verification during the existing locked append path;
- the first-broken-sequence error contract;
- read, export, recovery, and append behavior after verification failure.

The checksum chain is tamper-evident only within the retained event sequence. Because the chain head is stored in the same locally rewritable store, it cannot by itself detect rollback to an older valid file or deletion of a valid tail. Claiming rollback or tail-deletion protection requires an independently stored trusted checkpoint, signature, remote witness, or append-only medium; none is adopted here.

Trust-sensitive dispatch must fail closed unless the retained chain verifies completely. `LEGACY_UNVERIFIED` is not a dispatchable state: unverified history confers no trust, and no partially-trusted status may be produced by an ordinary write. Read-only inspection and export should remain available with an explicit degraded-integrity result so operators can diagnose and recover the store.

Acknowledged archive-and-reset must accept every state an operator can be stranded in, including `LEGACY_UNVERIFIED` and malformed bytes. A corrective path that refuses the states operators actually encounter pushes them toward unsafe workarounds.

Tombstone creation must not be unconditionally disabled by corruption. The implementation design must provide a recovery or repair-record path; otherwise the integrity mechanism can prevent recording corrective state.

This does not provide signatures, remote attestation, actor identity proof, or an append-only filesystem. W3C PROV-O export remains excluded until a concrete interoperability or compliance consumer exists.

## 4. Repository Quality Contracts

Do not introduce a separate "competency question" subsystem or a fourth result
vocabulary. Route each new check to the owner that already evaluates that class of
claim, and adopt that owner's existing result shape unchanged.

Three owners exist today, and they do not share one vocabulary. A check must pick one:

`evaluateSemanticContracts` in `ontoindex/src/core/runtime/semantic-contracts.ts`
owns per-claim evidence rules over runtime diagnostics. It returns
`{ passed, violations, summary.byContract }`, not a status enum. Use it when the check
is a property every emitted diagnostic must satisfy.

`PreCommitCheckState` in `ontoindex/src/mcp/super/pre-commit-audit.ts` owns
commit-time gating and uses `PASS`, `FAIL`, `DEGRADED`, `SKIPPED`. Use it when the
check must influence a commit verdict.

`evaluate_oracles` in `eval/structural_oracles.py` owns SWE-bench evaluation and uses
`PASS`, `FAIL`, `DEGRADED`, `NOT-MEASURED`. It is Python evaluation-harness code with
no TypeScript callers. Use it only for evaluation-time conformance of a task solution,
never for product index quality.

Candidate checks and their owners:

- every emitted call edge exposes its resolution evidence: semantic contract;
- every reported execution process reaches source citations: semantic contract;
- every indexed route resolves to an implementation handler: product report surface;
- every traced requirement reaches implementation or test evidence: product report surface, reusing existing docs-trace status values;
- changed public symbols identify likely tests: pre-commit checklist, and blocked until real coverage ingestion replaces filename-derived heuristics.

Index-quality checks over a whole repository are product-runtime concerns. Do not add
them to the evaluation oracle stage, which exists to grade one task solution inside an
eval container.

Each check must define a stable identifier and version, applicable repository profile,
deterministic evaluator, its owner's result shape, stable machine reason codes,
coverage numerator and denominator when meaningful, graph generation, manifest digest,
coverage and authority state when graph-backed, and bounded evidence and remediation
text.

Unsupported or unrunnable checks must degrade, never silently pass. Where the owner has
no degraded state, the check must report a violation or an explicit not-measured
diagnostic rather than an empty pass. Checks are diagnostics by default. Promotion to a
policy gate requires measured false-positive and degraded rates and must use the
existing pre-commit checklist.

## 5. Audit Decision Explanations

Do not introduce a `DecisionRecord` store. Existing audit events remain authoritative, and `buildAuditProjection` remains the state reconstruction mechanism.

Add a read-only decision-explanation projection only for a concrete query that current projections cannot answer. Candidate explanations are limited to:

- verification verdicts;
- status transitions;
- dedupe or root-cause selection;
- tombstone creation;
- dispatch approval or refusal;
- scope-guard outcomes.

The view may expose event ids, inputs already present in events, evidence, actor, reason codes, outcome, target snapshot, and omitted-data warnings. Missing event fields must be added to the owning event type rather than written to a parallel decision store.

Business decision modeling, generic approval workflows, and semantic precedent search remain out of scope.

## 6. Bounded Explanation Paths

Expose explanation paths only by traversing existing evidence, derivation, call, impact, process, requirement, and audit-event relationships.

Candidate paths include:

- source reference to resolved definition;
- changed symbol to impacted caller or process;
- audit claim to verifier evidence to lifecycle status;
- requirement to implementation to test evidence;
- tombstone to fix invariant to negative evidence.

Paths must be bounded, cycle-safe, freshness-aware, authority-aware, and citation-backed. Each new path requires a concrete consumer that cannot be served by an existing context, impact, docs-trace, audit projection, or process response.

This is presentation and traversal over deterministic analysis, not a causal inference engine. Do not add Rete, Datalog, SPARQL reasoning, probabilistic causality, or unrestricted user-defined rules.

## 7. Provenance-Preserving Evidence Fusion

Existing RRF and resolution traces already retain substantial provenance. Extend them only where a current public response demonstrably loses information needed by a consumer.

The gap analysis must check for:

- original candidate identifiers;
- source lane and rank;
- raw score and normalized score when one exists;
- lane weight and contribution;
- authority and freshness;
- duplicate or equivalence reason;
- final selected identity and aggregate score;
- deterministic identity-selection rationale.

Do not schedule a broad fusion phase merely to reproduce fields already present in `RRFTraceEntry` or `ResolutionEvidence`. Do not build a general entity-merging subsystem.

Exact duplicate-code discovery remains governed by `ADR_DUPLICATE_CODE_DISCOVERY.md`, including its external-tool-first and proof-gated semantic-mode decisions.

## Shared Constraints

- Reuse existing response envelopes, evidence classes, freshness metadata, authority results, event storage, semantic contracts, and structural oracles.
- Keep outputs bounded and machine-readable.
- Preserve degraded, unsupported, stale, and ambiguous states without inventing certainty.
- Add no storage backend for these changes.
- Add no Python runtime or Semantica package dependency.
- Add no generic enterprise ingestion, agent memory, ontology generation, business knowledge graph, or policy-rule features.
- Version every persisted schema and provide backward-compatible readers or an explicit migration.
- Require one concrete failing example or consumer before extending an existing trace or projection.

## Delivery Gates

### Gate A: Evidence Conflicts

1. Define one versioned fact key and incompatibility rule at its owning subsystem.
2. Demonstrate a current hidden-winner or flattened-conflict case.
3. Return that conflict explicitly with bounded evidence.

Accepted when one real fact family distinguishes candidate ambiguity from contradictory normalized claims and resolves only under an existing unique-winner policy.

### Gate B: Historical Evidence

1. Choose one persisted evidence family.
2. Bind it to the existing source-manifest and generation identity.
3. Demonstrate queries against two refs and one dirty-worktree snapshot.
4. Prove ancestry-aware applicability without full graph snapshots.

Accepted when the response distinguishes requested snapshot, source validity, observation time, and graph authority without using a global commit interval.

### Gate C: Audit Integrity

1. Specify canonicalization, hashing, migration, and recovery.
2. Detect interior mutation, insertion, and reordering deterministically.
3. Prove locked concurrent appends preserve the chain.
4. Verify that read/export remains diagnostic while dispatch fails closed.
5. State explicitly whether rollback protection is absent or backed by an independent checkpoint.

Accepted when the implementation detects exactly the integrity failures it claims and does not prevent a documented recovery path.

### Amendment Gates

- Add a repository quality check only through one named existing owner, using that owner's result shape without introducing a new status vocabulary.
- Do not add product index-quality checks to the evaluation oracle stage.
- Add a decision explanation only for a named query missing from current projections.
- Add an explanation path only for a named consumer missing from current graph, docs, or audit responses.
- Add fusion fields only after a response-level provenance-loss test fails.

## Consequences

Positive:

- contradictory facts become explicit without relabeling ordinary ambiguity;
- historical evidence aligns with OntoIndex's source-manifest authority model and Git's DAG;
- audit history can detect bounded classes of local corruption without overstating security guarantees;
- existing quality, audit, explanation, and retrieval owners are reused instead of duplicated;
- each change can be accepted, deferred, or rolled back independently.

Negative:

- each fact family must define canonical identity and incompatibility rules before it can emit conflicts;
- historical queries require source manifests and ancestry-aware semantics rather than two simple commit fields;
- audit integrity requires a persisted-schema migration and recovery design;
- rollback or valid-tail deletion remains undetectable without an independent trust anchor;
- some donor concepts produce no implementation work until a concrete missing capability is demonstrated.

## Non-Goals

- General-purpose decision intelligence.
- Full graph snapshots for every commit.
- W3C PROV-O, OWL, SHACL, or SKOS interoperability.
- Rete, Datalog, SPARQL, or arbitrary policy-rule execution.
- Generic entity resolution or knowledge-graph deduplication.
- Databricks, Snowflake, RDF-store, or alternate graph-database support.
- Replacing LadybugDB, Git, sidecars, existing retrieval lanes, semantic contracts, structural oracles, or audit projections.

## Placement

This repository ignores `/docs/`, so this ADR remains at the repository root as `ADR_SEMANTICA_EVIDENCE_AND_GOVERNANCE_ADOPTION.md` until a tracked ADR directory exists.
