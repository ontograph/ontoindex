# Compact pre-edit answers in the existing safety owner

## Status

Accepted for implementation.

## Decision

`audit({ action: "safe_edit_check", symbol: "<name or canonical UID>", minimal: true })` returns a compact pre-edit answer through `gnSafeEditCheck`. The direct `gn_safe_edit_check` tool accepts the same option. Omitted or false `minimal` preserves the existing report and safe-refactor behavior. `legacyResponse` independently selects the existing response envelope.

The answer retains the resolved target, verdict, reasoning, freshness and warnings. It includes at most ten direct dependent symbols, five candidate test files and five reasoned reading files. Dependents retain relation, confidence and provenance when available. Each capped section reports omitted known entries; upstream traversal omissions remain explicitly unknown when the graph probe is incomplete. Direct counts describe the existing depth-one relation set and exclude tests. Candidate tests use existing import/co-change heuristics and do not establish executed coverage. Empty test evidence cannot distinguish no matches from a failed discovery probe.

The implementation reuses the existing impact batch and `projectReadFirstFiles`; it adds no graph query, dependency, tool, index, or separate orchestration owner. Missing targets and unavailable graph evidence retain caution and explicit limitations. A name-selected target is identified as such so callers can use a canonical UID to avoid ambiguity.

## Alternatives and challenge

Extending the discovery task-pack would mix ranked search candidates with an edit target, add probes and duplicate pre-edit composition. A new context/impact orchestrator would duplicate identity resolution, freshness handling and routing. Both increase compatibility, performance, security review and rollback surfaces. Neither provides a correctness advantage over the existing safety owner.

Merely slicing the existing report is insufficient: it discards dependent identities and can make missing evidence appear complete. The selected projection retains probe limitations, preserves safety decisions and bounds only presentation. Existing default callers remain compatible; rollback removes the opt-in projection. Tests must exercise legacy and enveloped compact responses, unchanged defaults, caps and omissions, stale or unavailable evidence, unknown targets and propagated resource failures.
