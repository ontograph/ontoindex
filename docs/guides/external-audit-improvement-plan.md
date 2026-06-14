# External Audit Improvement Plan

Last updated: 2026-06-13
Status: Challenged and narrowed
Owner: OntoIndex maintainers

## Purpose

Convert the external audit into a product improvement plan that strengthens OntoIndex's core
agent-safety workflow without creating a parallel memory platform, a replacement graph backend, or
another agent runtime.

## Architecture-Fit Gate

### Gate 1: Real new functionality

Accepted work must add a capability users can observe:

- fewer wrong-repo and stale-index answers;
- safer MCP behavior during active edits;
- smaller default MCP tool surface;
- explicit embedding retention/generation behavior;
- clearer local-first install and UI workflows.

Rejected work:

- renaming existing commands;
- documenting existing behavior as if it were new;
- adding new wrappers over current tools without changing behavior;
- adding broad "agent memory" features that do not improve code graph safety.

### Gate 2: Core extension only

Accepted work must extend existing OntoIndex subsystems:

- CLI commands and analyze lifecycle;
- MCP facade and routing;
- graph freshness, repo resolution, and diff mapping;
- embeddings and search lifecycle;
- local HTTP UI and generated wiki/docs.

Rejected work:

- replacing LadybugDB in this plan;
- making mem0, Letta, Neo4j, or an external vector store part of the core path;
- replacing static graph analysis with LSP-only behavior;
- adding a second source-of-truth graph.

## Audit Verdict

### Accepted findings

1. OntoIndex's strongest product position is agent safety before edits, not generic code search.
2. MCP tool sprawl is real and should be hidden behind a smaller facade surface.
3. Repo freshness and repo identity must be visible in high-risk answers.
4. A stale graph after edits can be worse than no graph if the answer is presented as trusted.
5. Full graph refresh is still too coarse for active edit loops.
6. Embedding lifecycle semantics are too easy to misunderstand.

### Corrected findings

1. Local/offline use already exists through CLI, MCP, `serve`, local browser UI, and generated wiki.
2. Embeddings already use cached reuse; the gap is operator clarity and graph-delta refresh.
3. LadybugDB risk is operational, not yet a reason to replace the storage layer.
4. LSP is a useful live signal source, but it cannot replace OntoIndex process graphs, docs evidence,
   routes, tools, and cross-language graph analysis.

## Product Goal

Make OntoIndex trustworthy during agent-assisted editing by making freshness, repo scope, and dirty
workspace risk explicit in every high-risk workflow.

## Non-Goals

- No new general memory product.
- No database replacement.
- No hosted-service dependency.
- No broad new MCP tool family.
- No full symbol-level incremental compiler project in the first phase.

## Required Design Constraint

Every accepted task must answer this question:

> If an agent uses this during a code edit, does it reduce the chance of acting on wrong, stale, or
> incomplete graph evidence?

If the answer is no, postpone it.

## Workstreams

### W1. Freshness Contract in High-Risk Answers

Priority: Must do first.

Problem:

- MCP and CLI answers can be technically correct for the indexed graph while unsafe for the current
  workspace state.

Scope:

- `impact`
- `gn_verify_diff`
- docs/evidence tools
- `refactor`
- `review`
- `gn_ensure_fresh`
- repo status and context resources

Implementation:

- Attach a compact freshness envelope to high-risk responses:
  - `repoLabel`
  - `repoPath`
  - `indexedCommit`
  - `headCommit`
  - `isStale`
  - `dirtyFileCount`
  - `scopeConfidence`
- Fail or warn loudly when `ONTOINDEX_MCP_REPO`, MCP cwd, and resolved repo path disagree.
- Return exact retry examples when repo selection is ambiguous.

Acceptance:

- a wrong-repo MCP process cannot silently return normal-looking impact or diff answers;
- stale answers are marked in the first screen of output;
- tests cover repo label, absolute path, cwd fallback, and mismatch behavior.

### W2. Dirty Workspace Overlay

Priority: Must do before claiming active-edit safety.

Problem:

- After the first edit, the static graph may no longer describe the working tree.

Scope:

- dirty file detection;
- changed symbol approximation;
- impact/refactor/review warning surfaces.

Implementation:

- Build a read-only overlay from `git diff --name-only`, staged diff, and untracked source files.
- Map dirty files to indexed symbols where possible.
- Mark affected graph answers as:
  - `clean`
  - `dirty-file`
  - `stale-index`
  - `unknown-untracked`
- Do not invent new edges from dirty files in the first version.

Acceptance:

- editing one indexed file causes impact/refactor answers touching that file to carry a dirty warning;
- untracked source files are reported as unknown graph coverage;
- answers never imply that dirty overlay data has full graph precision.

### W3. Facade-First MCP Surface

Priority: Must do, but after W1 schema is stable.

Problem:

- Exposing dozens of tools as the default interface increases agent selection noise.

Scope:

- keep internal functions;
- narrow the recommended public surface.

Implementation:

- Treat these as the documented top-level agent tools:
  - `discover`
  - `search`
  - `inspect`
  - `impact`
  - `review`
  - `refactor`
  - `docs`
  - `freshness`
- Move advanced or legacy entry points behind `discover` guidance and docs.
- Update generated AGENTS/CLAUDE guidance to prefer facade tools.

Acceptance:

- common workflows are expressed through the facade tools;
- tool docs no longer train agents to choose among dozens of similar low-level tools;
- no existing low-level capability is removed without migration notes.

### W4. Embedding Lifecycle Modes

Priority: Should do after W1.

Problem:

- Operators cannot easily predict whether embeddings will be preserved, refreshed, skipped, or absent.

Implementation:

- Add explicit modes:
  - `off`
  - `preserve`
  - `refresh`
- Show mode, stored vector count, skipped-node reason, and provider in `status`.
- Preserve existing hash-based reuse.

Acceptance:

- `analyze` output states exactly what happened to embeddings;
- `status` explains semantic-search availability without the vague `missing-store` style of answer;
- docs show one Linux and one Windows example.

### W5. Local-First Product Framing

Priority: Should do as docs/product cleanup.

Problem:

- External readers can still misunderstand hosted/demo surfaces as the default path.

Implementation:

- README first-run flow should lead with:
  - install;
  - `analyze`;
  - `setup`;
  - `mcp`;
  - `serve`;
  - generated wiki.
- Hosted or GitHub Pages surfaces must be described as optional outputs, not required runtime.

Acceptance:

- README and generated docs make local-first behavior explicit;
- install examples remain current for Linux and Windows.

### W6. File-Delta Refresh

Priority: Postpone until W1 and W2 prove the safety contract.

Problem:

- Full analyze is too expensive as the only refresh path.

Reason to postpone:

- partial graph rebuild can reduce cost but also create false trust if edge invalidation is incomplete.

Allowed first slice:

- changed-file symbol rebuild;
- delete/recreate file-local `DEFINES`, `CONTAINS`, and direct local edges;
- compare result against a full analyze on fixture repos;
- mark output as experimental.

Not allowed in first slice:

- partial community recomputation;
- silent replacement of full analyze;
- claims of complete graph correctness.

Acceptance:

- fixture snapshots show no unexpected symbol drift versus full analyze for changed-file scenarios;
- fallback to full analyze is automatic when imports, exports, or language-provider behavior make the delta unsafe.

## Delivery Plan

### Phase 1: Trust Before Convenience

1. W1 Freshness Contract in High-Risk Answers
2. W2 Dirty Workspace Overlay
3. W3 Facade-First MCP Surface

Exit criteria:

- high-risk answers carry repo and freshness context;
- dirty workspace risk is visible;
- default agent docs use the facade tools.

### Phase 2: Operator Clarity

1. W4 Embedding Lifecycle Modes
2. W5 Local-First Product Framing

Exit criteria:

- users can tell why semantic search is available, degraded, or absent;
- docs present local-first usage as the default.

### Phase 3: Refresh Cost Reduction

1. W6 File-Delta Refresh experimental slice

Exit criteria:

- delta refresh proves correctness on fixture snapshots before becoming a default workflow.

## Test Strategy

- Unit tests for freshness envelope construction.
- MCP integration tests for wrong cwd, wrong `ONTOINDEX_MCP_REPO`, repo label, and absolute path.
- CLI tests for exact retry guidance on ambiguous repositories.
- Dirty workspace fixture tests:
  - unstaged edit;
  - staged edit;
  - untracked source file;
  - clean working tree.
- Snapshot tests comparing experimental file-delta refresh with full analyze.
- Docs tests or examples for Linux and Windows install/setup paths.

## Risks and Controls

1. Risk: freshness metadata bloats responses.
   Control: compact envelope, full details only in `diagnose` or verbose mode.

2. Risk: dirty overlay overclaims precision.
   Control: warning-only overlay in first version; no synthetic graph edges.

3. Risk: facade tools hide power-user capabilities.
   Control: keep `discover` as the advanced routing surface.

4. Risk: file-delta refresh corrupts trust.
   Control: experimental flag, snapshot comparison, automatic full-analyze fallback.

5. Risk: embedding modes create migration friction.
   Control: preserve current default behavior for one release, emit migration hints, then switch docs.

## Decision

Proceed with W1, W2, W3, W4, and W5.

Postpone W6 as a gated experimental track.

Reject memory-platform expansion, storage replacement, and LSP-only replacement as out of scope for
this plan.

## Execution Tracking

Tracking rule: update this section before starting each task, then refresh the OntoIndex index after
the task is completed.

| Task | Owner | Status | Validation | Index Refresh |
| --- | --- | --- | --- | --- |
| T1: W1 freshness contract in high-risk answers | sub-agent | Completed | Targeted tests, typecheck, detect-changes | Completed |
| T2: W2 dirty workspace overlay | sub-agent | Completed | Targeted tests, typecheck, diff check | Completed |
| T3: W3 facade-first MCP surface | sub-agent | Completed | Facade/help/tool-contract tests, typecheck | Completed |
| T4: W4 embedding lifecycle modes | sub-agent | Completed | Status/analyze/embedding tests, typecheck | Completed |
| T5: W5 local-first product framing | sub-agent | Completed | README prettier check | Completed |
| T6: W6 file-delta refresh experimental slice | sub-agent | Completed | Experimental delta tests, CLI help tests, typecheck | Completed |
| T7: Senior review of `statusCommand` critical diff audit | sub-agent | Completed | Status tests, typecheck | Completed |

Final validation:

- Targeted unit suites: passed, 232 tests.
- Typecheck: passed.
- Build: passed.
- Full Prettier check: passed.
- OntoIndex refresh after each completed task: completed; current commit index already up to date.
- Diff audit: completed with residual high-risk warning on `statusCommand` / repo path resolution;
  T7 fixed the path-like `--repo` handling gap and expanded targeted status coverage.
