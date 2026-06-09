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
| [0014](0014-measurement-gated-rust-native-kernels.md)          | Measurement-gated Rust native kernels                         | Proposed (measurement-gated)     | large-codebase scalability plan           |
| [0015](0015-post-index-enrichment-sidecar.md)                  | Post-index enrichment sidecar                                 | Accepted/Proposed split          | parser-performance sidecar decision       |
| [0016](0016-resource-lifecycle-graph-systems-auditor.md)       | Resource Lifecycle Graph and Systems Auditor overlay          | Proposed                         | systems-auditor; update 2026-06-01        |
| [0017](0017-audit-lifecycle-layer.md)                          | Audit Lifecycle Layer and Memory Consolidation                | Proposed                         | audit governance proposal; updates 2026-06-01 |
| [0018](0018-mcp-audit-trust-contract.md)                       | MCP Audit Trust Contract and Customer Readiness Gates         | Proposed                         | customer-development audit review         |
| [0019](0019-real-query-replay-gates.md)                        | Query replay reports for retrieval changes                    | Postponed                        | GBrain architecture challenge review      |
| [0020](0020-graph-aware-review-reports.md)                     | Graph-aware diff review and review reports                    | Proposed                         | Graphify architecture challenge review    |
| [0021](0021-serena-inspired-agent-interface.md)                | Serena-inspired agent interface for OntoIndex                  | Proposed                         | Serena architecture review                |
| [0022](0022-qmd-inspired-structured-retrieval.md)              | QMD-inspired structured retrieval and economic recommendations | Proposed                         | QMD architecture review; update 2026-06-01 |
| [0023](0023-serena-follow-up-memory-diagnostics-guardrails.md) | Serena follow-up memory and diagnostics guardrails            | Proposed                         | Serena follow-up challenge review         |
| [0024](0024-crush-inspired-evidence-read-ledger.md)            | Crush-inspired evidence read ledger and local control plane   | Proposed                         | Crush architecture review                 |
| [0025](0025-codex-inspired-tool-contract-registry.md)          | Codex-inspired tool contract registry and schema drift gates  | Implemented                      | Codex architecture review                 |
| [0026](0026-knowledge-discovery-evidence-classification.md)    | Knowledge discovery and evidence classification surfaces      | Implemented                      | Claude Code architecture review           |
| [0027](0027-mcp-startup-surface-profiles.md)                   | MCP startup surface profiles and lazy tool loading            | Proposed - Challenged            | MCP startup-time review                   |
| [0028](0028-answer-engine-inspired-evidence-expansion.md)      | Answer-engine-inspired evidence expansion                     | Proposed - Challenged            | LLM answer engine architecture review     |
| [0029](0029-native-knowledge-graph-document-sidecar.md)        | Native knowledge graph document sidecar and conceptual mapping | Implemented                      | KG-Gen review; updates 2026-06-01         |
| [0030](0030-falkordb-inspired-query-budgets-and-response-diagnostics.md) | Query Budgets, Response Diagnostics, and Economic Retrieval | Partially Implemented | FalkorDB review; update 2026-06-01 |
| [0031](0031-graphify-inspired-evidence-diagnostics-for-existing-review-surfaces.md) | Graphify-inspired evidence diagnostics for existing review surfaces | Proposed - Challenged | Graphify architecture review |
| [0032](0032-understand-anything-inspired-guided-architecture-tours.md) | Understand-Anything-inspired guided architecture tours | Proposed - Review note | Understand-Anything architecture review |
| [0055](0055-palantir-foundry-inspired-native-transactional-ontology-edits-and-gated-actions.md) | Palantir-Foundry-inspired native transactional ontology edits and gated actions | Proposed - Challenged/Core Only | Palantir Foundry review |
| [0059](0059-deep-reasoning-inspired-native-discovery-hypothesis-and-evidence-to-logic-mapping.md) | Deep-Reasoning-inspired native discovery and grounding | Proposed | arXiv:2507.09477 review; update 2026-06-01 |
| [0065](0065-codexgraph-inspired-native-graph-query-and-subgraph-extraction.md) | CodexGraph-inspired native direct graph query logic and schema-aware context | Proposed | arXiv:2408.03910 review |
| [0067](0067-hierarchical-summary-propagation-and-temporal-structural-hybrid-retrieval.md) | Hierarchical Knowledge Management, Bridge-Aware Retrieval, and Agentic Navigation | Proposed | Awesome-GraphRAG review; updates 2026-06-01 |
| [0074](0074-ontologx-inspired-native-formal-ontologies-and-neurosymbolic-reasoning.md) | Ontologx-inspired native formal ontologies and neurosymbolic reasoning | Proposed | Ontologx review |
| [0076](0076-ontogpt-inspired-native-linkml-schema-governance-and-recursive-spires-extraction.md) | OntoGPT-inspired native LinkML schema governance and recursive SPIRES extraction | Proposed | OntoGPT review |
| [0079](0079-smart-composer-inspired-native-interactive-context-staging-and-hunk-editing.md) | Smart-Composer-inspired native interactive context staging and hunk editing | Proposed | Obsidian Smart Composer review |
| [0081](0081-virtuoso-inspired-native-multi-model-virtual-views-and-anytime-queries.md) | Virtuoso-inspired native multi-model virtual views and anytime queries | Proposed | OpenLink Virtuoso review |

## How to add a new ADR

1. Pick the next unused number (zero-padded to 4 digits).
2. Copy the structure from an existing ADR (e.g. 0001).
3. Always include the **Algorithm/Technique** section with concrete code references (file:line) and step-by-step procedures.
4. Update this index.
5. If the new ADR supersedes a prior one, link both ways and mark the old one Superseded.

## Cross-references

- Each ADR links to its source code file when applicable.
- ARCHITECTURE.md is the high-level system overview; ADRs are the per-decision detail.
