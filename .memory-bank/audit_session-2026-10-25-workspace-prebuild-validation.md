# Workspace prebuild and candidate validation

The candidate reader now reuses `buildScopeTree`, requires its declared module
to be the sole root Module, and verifies per-scope file ownership. Persisted
identifiers are excluded from the fixed validation error. Candidates remain
`seedReady: false`. Twelve rehashed malformed-tree cases and one valid nested
tree case cover the boundary.

Two persisted differential scenarios demonstrate that adding/removing an export
changes the call edge from an unchanged importing caller. This is replay fixture
evidence; production dependency invalidation and admission remain open.

Native Linux validation completed with exit 0:

- Six required-language resolver suites: 758 tests, 110.85 seconds.
- Reader, persisted parity, prebuild and runtime suites: 319 tests, 20.52 seconds.
- Persisted edit differential suite: 20 tests, 21.98 seconds.
- Package build compiled shared/product TypeScript and copied existing native artifacts.
- Bounded OntoIndex verify_diff passed file scope; symbol scope was not checked.
- Explicit workspace prebuild: complete coverage, 46.10 seconds, 2502380 KiB peak RSS.
- Repeated prebuild: reused complete coverage, 1.03 seconds, 180676 KiB peak RSS.

An isolated packed installation is retained at
`/home/er77/.local/opt/ontoindex-2.3.5-rc.12-workspace-20261025-verified`.
Offline installation failed ENOTCACHED after cache cleanup. Normal npm installation
completed. Package-owned native setup required npm's bundled node-gyp and the
LadybugDB install script; CLI startup and parser identity equality then passed.
Four installed SDK MCP inspections found the new reader from `workspace-graph`:
1225, 850, 1046 and 1064 ms. These samples do not establish p95 acceptance and
exceed the one-second warm budget in two measured warm calls.

The configured old installation has a different parser identity and continued
to return workspace_too_large. The OntoIndex MCP executable path in host config
now selects the validated installation; TOML parsed successfully. The prior
workspace-20261024n installation is retained for rollback and the CLI target
remains unchanged. Existing live connections have not been reloaded. No live
process was stopped, no committed index replaced, and no release published.

Remaining: production replay admission and coherent graph publication; C++/Rust
scope capture and supported-syntax coverage; full replay-wide consistency;
repeated performance acceptance and live-connection reload verification.
JS/TS/Python/C++/Rust legacy resolver success does not establish scope replay
support. Kotlin, Dart, Ruby and Windows remain deferred.

## Inventory validation follow-up

Workspace inventory hashing now uses four-file batches and waits for every
started read before returning. Error selection preserves inventory order and
every input still receives a content digest. Metadata-only reuse and watcher-only
invalidation were rejected because they cannot establish unchanged bytes.
Candidate reading additionally rejects scope IDs shared by different retained
files; opaque unique IDs remain accepted and seed readiness remains false.

Fresh validation: overlay and input-change suites passed 121 tests in 7.33 seconds
(exit 0). The initial run passed 120 tests and timed out in the new success-case
spy, which also gated a later overlay reread; releasing subsequent reads after
the inventory batches fixed the fixture. Package build exited 0, compiling shared
and product TypeScript and copying existing native artifacts. Bounded OntoIndex
file-scope verification passed; symbol scope was unspecified.

The installed candidate predates these source edits. Updated installation,
representative warm latency acceptance, production replay admission, and C++/Rust
capture remain open. Documentation changes invalidate the existing complete
workspace inventory; any final prebuild must follow documentation writes.
