# Replay loader and extraction parity

Current checkpoint: 2026-10-25. User authorized the five capture, resolution,
replay, runtime and Linux-validation tasks. Runtime admission remains open.

## Verified changes

- Workspace capture independently discovers model-pack manifests and freezes
  their membership and contents. Focused capture/execution suites: 130 passed.
- Ambient declarations and explicit member/type resolution: seven suites,
  818 passed after the native build.
- Candidate v4 retains sixteen families. The production reader now hydrates
  owned records within its existing bounded verification loop and returns only
  after final integrity checks. Reader suite: 202 passed.
- Sequential/recovery route, decorator-route and tool extraction now shares
  worker collectors and feeds existing staging through an awaited callback.
  Five route/tool/replay suites: 97 passed. Fallback suite: 73 passed.
- `parse-replay.ts` restores existing model/context/binding owners, validates
  graph references and map conflicts, resolves all retained calls/writes and
  stages graph changes before publication. Its unit suite and full-graph replay
  parity suite: 43 passed, covering JavaScript, TypeScript, Python, C++ and Rust
  across sequential, worker and recovery modes.
- Seven workspace supervisor, durability, capture and committed-navigation
  suites: 156 passed. Latest `ONTOINDEX_MAX_WORKERS=4 npm run build`: exit 0.

All test commands used native Vitest with `ONTOINDEX_TEST_WORKERS=4` and
`--maxWorkers=1`; no detached jobs or containers were used. Counts above are
separate scoped runs, not a complete-suite total. All listed runs exited 0.

## Corrections and evidence limits

The extraction parity failure exposed a real missing sequential producer path.
The independent fetch-edge assertion now checks the actual `FETCHES` contract.
Reader single-open validation required exact paths because `routes.jsonl` is
also a suffix of `decorator-routes.jsonl`. Fallback expectations were updated
for sixteen completion keys and the existing scoped import-config argument.

OntoIndex committed HEAD matches `2623820ec85113c28b238d5f72dde496e27426a1`;
uncommitted work remains outside that graph. Bounded extraction/reader
`verify_diff` returned PASS with impact capped at 25 symbols and no symbol-scope
assertion. Source and executed checks are authority for new files.

## Remaining acceptance

Candidate manifests still report `seedReady: false`. The loader and
reconstruction helper are exercised by integration tests; runtime analysis does
not yet select them. Admission must bind the actual captured source/configuration,
model packs, pipeline profile and complete executing analyzer contract, require
strict retained inventory and producer completion, and preserve fallback and
cancellation behavior.

Reuse `acquireOverlayGenerationPin` for candidate reads; workspace persistence
belongs to the existing staged overlay generation. Current parser identity
hashes selected files and is insufficient for complete replay-code identity.
Resolve that contract before activating reuse. Then prove actual runtime parsing
is skipped, downstream parity, rejection/invalidation and pin/prune behavior.
Edited-source composition, performance measurements, complete required-language
Linux validation and isolated installation/CLI/MCP qualification remain open.
