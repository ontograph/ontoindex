# Replay identity review

Date: 2026-10-25. User scope: all five capture, replay, runtime and Linux tasks.

## Changes and validation

- Corrected the scope rejection fixture to use unsupported union annotations.
  Full scope-resolution directory: 29 files, 1,595 tests passed, exit 0.
- Replaced the selected parser implementation list with sorted bounded runtime
  artifact inventories. Source execution includes shared dist; built execution
  requires bundled shared code. Reads reject symlinks, special files, size and
  entry overruns, observed replacement and membership changes. Domain is v4.
- Added JavaScript to the existing native grammar identity/restart guard.
  Workspace capture and artifact identity suites: 138 tests passed, exit 0.
- Replay reconstruction checks registration node existence, type, symbol name
  and source location before restoring registries. C++ declaration/definition
  paths and direct registry aliases remain supported. The mismatch diagnostic
  is bounded and contains no persisted identifiers.
- Final native build: `ONTOINDEX_MAX_WORKERS=4 npm run build`, exit 0.
- Final reconstruction and two replay parity suites: 70 tests passed, exit 0.
  Coverage includes JS, TS, Python, C++ and Rust with sequential, worker and
  recovery parsing. This is fixture parity, not complete runtime acceptance.
- Compiled artifact identity returned equal hashes on two calls: 354 ms and
  264 ms. This single observation is not a performance benchmark.
- Scoped whitespace check exited 0. OntoIndex bounded verify_diff returned PASS;
  impact was capped at 25 symbols and expectedSymbols was not supplied.

Commands ran natively with Vitest `--maxWorkers=1` and
`ONTOINDEX_TEST_WORKERS=4`. All command sessions were harvested. No install,
publication, commit, detached task or container was performed.

## Review decisions

An expanded selected-file list remains omission-prone. Import-closure discovery
would duplicate module resolution and require dynamic-import handling. A bounded
runtime tree inventory catches new modules and assets automatically, at the cost
of conservative invalidation and additional filesystem reads.

Endpoint existence alone permits a registration for `target` to point to the
existing `caller` node. Reconstructing IDs or demanding identical full metadata
would reject valid C++ and registry alias cases. Existing graph correspondence
provides the narrower check with positive and negative regressions.

## Remaining work

The artifact digest describes disk bytes. Node can retain previously loaded
JavaScript after disk edits; lazy imports and workers have their own load timing.
Matching before/after disk hashes do not establish an immutable loaded runtime.
The existing supervised child is the integration owner for a startup identity
boundary. A versioned installation path alone is not evidence of immutability.

Runtime admission remains disabled and candidate `seedReady` remains false.
Remaining acceptance: startup identity and exact same-source admission, staged
workspace candidate persistence/pinning, actual parser-skip and fallback proof,
edited-source composition, invalidation/cancellation and performance acceptance,
complete required-language Linux validation, then isolated install/CLI/MCP proof.
No active task was selected by the existing closed structured tracker; its state
was not modified. Current edits preserve the extensive pre-existing dirty tree.

OntoIndex committed HEAD matches `2623820ec85113c28b238d5f72dde496e27426a1`.
Current source contains uncommitted owners absent from that graph. Committed
impact resolved the former parser identity owner with LOW risk; replay
reconstruction was not in the index. Source inspection and executed tests are
authority for these changes.
