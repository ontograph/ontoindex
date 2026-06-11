# Architecture Decision Records

Index of architectural decisions, techniques, and algorithms documented for OntoIndex.

## Format

Each ADR follows: **Context → Decision → Algorithm/Technique → Consequences**. The Algorithm/Technique section is the load-bearing protocol — it captures the actual implementation approach, not just the decision direction.

## Status legend

- **Accepted** — currently in production code
- **Proposed** — approved direction, but implementation remains gated by benchmarks or follow-up work
- **Superseded** — replaced by a newer ADR; details kept for history
- **Deprecated** — removed; details kept for archaeology

## Index

### MCP Function ADR Catalog

| # | Title | Status | Source |
| [MCP](mcp-functions/0000-index.md) | OntoIndex MCP function ADR pages | Accepted | Generated from MCP tool registry |

### Architectural ADRs

| #                                                              | Title                                                         | Status                           | Source                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------- | ----------------------------------------- |
| [0001](0001-worker-pool-parser-architecture.md)                | Worker pool parser architecture and large-repo profiles       | Accepted                         | v12 P1; updates 2026-06-01                |
| [0002](0002-per-intent-embedder-ensemble.md)                   | Per-intent embedder ensemble and retrieval diagnostics        | Accepted (env-gated)             | v13 W1b; updates 2026-06-01               |
| [0003](0003-cross-encoder-rerank-batched.md)                   | Cross-encoder rerank batched + intent-conditional             | Accepted (env-gated)             | v11 W2a/b + v13 W1b-step3                 |
| [0004](0004-citation-graph-path-bfs.md)                        | Citation graphPath BFS and Associative Retrieval              | Accepted (env-gated)             | v11 W3a/b; HippoRAG update 2026-06-01     |
| [0005](0005-gitmining-co-changed-with.md)                      | gitMining CO_CHANGED_WITH temporal coupling                   | Accepted                         | v9-v11                                    |
| [0006](0006-embedding-pipeline-paged.md)                       | Embedding pipeline paged batching                             | Accepted (opt-in `--embeddings`) | perf-stability + F1                       |
| [0007](0007-server-job-manager.md)                             | Server JobManager persistence + per-repo concurrency          | Accepted                         | perf-stability                            |
| [0008](0008-frontend-summary-mode.md)                          | Frontend summary mode for huge graphs                         | Accepted                         | perf-stability                            |
| [0009](0009-relationship-copy-fallback.md)                     | Relationship COPY fallback + 1000-edge guard                  | Accepted                         | perf-stability                            |
| [0010](0010-stdout-silencing-scope.md)                         | stdout silencing scope reduction                              | Accepted                         | perf-stability + A1                       |
| [0011](0011-skeleton-first-default-on.md)                      | Skeleton-first viewing default                                | Accepted (default-on)            | v8 W0b (Pillar 1)                         |
| [0012](0012-intent-classifier.md)                              | Intent classifier + confidence soft-gate                      | Accepted                         | v6/v8/v13; update 2026-06-01              |
| [0013](0013-lsp-bridge-integration.md)                         | LSP bridge integration                                        | Accepted (env-gated)             | v8 W1c-pivot                              |
| [0014](0014-measurement-gated-rust-native-kernels.md)          | Measurement-gated Rust native kernels                         | Accepted (partially implemented, opt-in) | large-codebase scalability plan; native package landed |
| [0015](0015-post-index-enrichment-sidecar.md)                  | Post-index enrichment sidecar                                 | Postponed                        | parser-performance sidecar decision       |
| [0016](0016-resource-lifecycle-graph-systems-auditor.md)       | Core systems-audit coverage manifest                         | Implemented (core coverage manifest) | systems-auditor; narrowed and implemented 2026-06-10 |
| [0017](0017-audit-lifecycle-layer.md)                          | Audit Lifecycle Layer and Memory Consolidation                | Implemented                      | audit governance proposal; updated 2026-06-09 |
| [0018](0018-mcp-audit-trust-contract.md)                       | MCP Audit Trust Contract and Customer Readiness Gates         | Implemented (core contract)      | customer-development audit review; updated 2026-06-09 |
| [0019](0019-real-query-replay-gates.md)                        | Core retrieval replay gates                                   | Proposed - Challenged/Core Extension Only | retrieval regression review; narrowed 2026-06-10 |
| [0020](0020-graph-aware-review-reports.md)                     | Graph-aware diff review and review reports                    | Implemented (v1 local review)    | Graphify architecture challenge review; updated 2026-06-09 |
| [0021](0021-serena-inspired-agent-interface.md)                | Core symbol-first agent workflow plan contract                 | Implemented (core workflow plan contract) | Serena architecture review; narrowed and implemented 2026-06-10 |
| [0022](0022-qmd-inspired-structured-retrieval.md)              | QMD-inspired structured retrieval and economic recommendations | Partially Implemented            | QMD architecture review; updated 2026-06-09 |
| [0023](0023-serena-follow-up-memory-diagnostics-guardrails.md) | Serena follow-up memory and diagnostics guardrails            | Implemented                      | Serena follow-up challenge review; updated 2026-06-09 |
| [0024](0024-crush-inspired-evidence-read-ledger.md)            | Crush-inspired evidence read ledger and local control plane   | Implemented                      | Crush architecture review; index corrected 2026-06-09 |
| [0024-FU](0024-follow-up-permission-hooks.md)                  | Deferred permission and hook design                           | Proposed / Deferred              | ADR 0024 follow-up                        |
| [0025](0025-codex-inspired-tool-contract-registry.md)          | Codex-inspired tool contract registry and schema drift gates  | Implemented                      | Codex architecture review                 |
| [0026](0026-knowledge-discovery-evidence-classification.md)    | Knowledge discovery and evidence classification surfaces      | Implemented                      | Claude Code architecture review           |
| [0027](0027-mcp-startup-surface-profiles.md)                   | Core MCP startup profile measurement gates                    | Proposed - Challenged/Core Extension Only | MCP startup-time review; narrowed 2026-06-10 |
| [0028](0028-answer-engine-inspired-evidence-expansion.md)      | Answer-engine-inspired evidence expansion                     | Implemented (core discipline)    | LLM answer engine architecture review; updated 2026-06-09 |
| [0029](0029-native-knowledge-graph-document-sidecar.md)        | Native knowledge graph document sidecar and conceptual mapping | Implemented                      | KG-Gen review; updates 2026-06-01         |
| [0030](0030-falkordb-inspired-query-budgets-and-response-diagnostics.md) | Query Budgets, Response Diagnostics, and Economic Retrieval | Partially Implemented | FalkorDB review; update 2026-06-01 |
| [0031](0031-graphify-inspired-evidence-diagnostics-for-existing-review-surfaces.md) | Core evidence diagnostic surface profiles | Implemented (core diagnostic profiles) | Graphify architecture review; narrowed and implemented 2026-06-10 |
| [0032](0032-understand-anything-inspired-guided-architecture-tours.md) | Core architecture tour composition | Implemented (core composition) | Understand-Anything architecture review; narrowed and implemented 2026-06-10 |
| [0055](0055-palantir-foundry-inspired-native-transactional-ontology-edits-and-gated-actions.md) | Palantir-Foundry-inspired native transactional ontology edits and gated actions | Postponed | Palantir Foundry review |
| [0059](0059-deep-reasoning-inspired-native-discovery-hypothesis-and-evidence-to-logic-mapping.md) | Core hypothesis grounding and evidence gap mapping | Implemented (core grounding) | arXiv:2507.09477 review; narrowed and implemented 2026-06-10 |
| [0065](0065-codexgraph-inspired-native-graph-query-and-subgraph-extraction.md) | Core graph schema manifest and subgraph context packaging | Implemented (core subgraph context packaging) | arXiv:2408.03910 review; narrowed and implemented 2026-06-10 |
| [0067](0067-hierarchical-summary-propagation-and-temporal-structural-hybrid-retrieval.md) | Core retrieval context composition and navigation provenance | Implemented (core retrieval context composition) | Awesome-GraphRAG review; narrowed and implemented 2026-06-10 |
| [0074](0074-ontologx-inspired-native-formal-ontologies-and-neurosymbolic-reasoning.md) | Core ontology constraint validation report contract | Implemented (core validation report contract) | Ontologx review; narrowed and implemented 2026-06-10 |
| [0076](0076-ontogpt-inspired-native-linkml-schema-governance-and-recursive-spires-extraction.md) | Core schema-guided recursive extraction bundle contract | Implemented (core extraction contract) | OntoGPT review; narrowed and implemented 2026-06-10 |
| [0079](0079-smart-composer-inspired-native-interactive-context-staging-and-hunk-editing.md) | Core interactive context staging and virtual diff selection | Implemented (core workspace contracts) | Obsidian Smart Composer review; narrowed and implemented 2026-06-10 |
| [0081](0081-virtuoso-inspired-native-multi-model-virtual-views-and-anytime-queries.md) | Core virtual source mapping and anytime result envelopes | Implemented (core virtual mapping and anytime envelope contracts) | OpenLink Virtuoso review; narrowed and implemented 2026-06-10 |
| [0082](0082-semantic-ann-neighbor-graph-and-one-shot-retrieval-frontier.md) | Semantic ANN neighbor graph and one-shot retrieval frontier | Implemented (opt-in core and analyze-time materialization) | Instagram semantic-memory prototype review; core primitives shipped in 1.9.1; analyze-time materialization added 2026-06-10 |

## How to add a new ADR

1. Pick the next unused number (zero-padded to 4 digits).
2. Copy the structure from an existing ADR (e.g. 0001).
3. Always include the **Algorithm/Technique** section with concrete code references (file:line) and step-by-step procedures.
4. Update this index.
5. If the new ADR supersedes a prior one, link both ways and mark the old one Superseded.

## Cross-references

- Each ADR links to its source code file when applicable.
- ARCHITECTURE.md is the high-level system overview; ADRs are the per-decision detail.
