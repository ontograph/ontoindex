# ADR 0027: Core MCP startup profile measurement gates

**Status:** Proposed - Challenged/Core Extension Only
**Source:** MCP startup-time review; narrowed 2026-06-10

## Context

The original ADR proposed MCP startup profiles, profile-aware help/contract reporting, hidden-but-callable compatibility, and lazy super-function loading. Current code review shows those are no longer future work:

- `McpStartupProfile`, `ONTOINDEX_MCP_STARTUP_PROFILE`, `public-full`, and profile filtering already exist in `ontoindex/src/mcp/shared/tool-registry.ts`.
- `getMcpStartupProfileToolReport()` already reports advertised tool count, hidden-but-callable count, full public count, facade inclusion, and `advertise_only` enforcement.
- `createMCPServer()` already reads the active startup profile and advertises `getPublicToolDefinitions({ startupProfile })`.
- `server.ts` avoids eager `dispatchSuper` import by dynamically importing `./super/dispatch.js` only in `dispatchLazySuper()`.
- `super/dispatch.ts` uses type-only imports at module load and dynamic imports inside dispatch cases.
- `gn_help` and `gn_tool_contract` already expose startup-profile state.
- Focused tests already cover startup profile parsing, profile counts, hidden-callable reporting, help output, contract output, and lazy server loading.
- Local OntoIndex search on 2026-06-10 found no `startup-profile-measurement`, `measureMcpStartupProfiles`, or `McpStartupProfileMeasurementReport` implementation.
- Existing `payloadBytes` fields belong to ingestion worker telemetry and do not measure MCP `ListTools` startup surfaces.

Those implemented surfaces should not be re-planned as ADR 0027 tasks. The remaining core gap is measurement: OntoIndex does not yet have a pure, reusable measurement contract that computes profile payload size and startup-surface deltas for release gating.

## Challenge Findings

1. Startup profile filtering is already implemented and tested.
2. Hidden-but-callable compatibility reporting is already implemented and tested.
3. Help and tool-contract profile reporting are already implemented.
4. Lazy super-function implementation imports are already in place.
5. Switching the default profile from `public-full` to `core` is a release compatibility decision, not a new core feature.
6. Schema compaction is risky because MCP input schemas are part of the stable contract.
7. Warm daemons, facade-first discovery, multiple MCP servers, and strict profile enforcement are product/runtime policies, not the remaining core extension.

## Decision

Add one core extension: a pure MCP startup profile measurement module that quantifies profile payload size and profile deltas without starting an MCP server or changing the advertised tool contract.

This keeps the part of ADR 0027 that is still new and core:

- measure startup profile payload size deterministically;
- compare `core`, `query`, `audit`, `refactor`, `systems`, and `public-full`;
- expose release-gate data before any default-profile switch;
- keep ADR 0025 registry data as the source of truth.

## Core Functionality

Create a pure module:

`ontoindex/src/mcp/shared/startup-profile-measurement.ts`

The module should expose types similar to:

- `McpStartupProfileMeasurement`
- `McpStartupProfileMeasurementInput`
- `McpStartupProfileMeasurementReport`
- `McpStartupProfileMeasurementDelta`
- `McpStartupProfileMeasurementLimits`

The module should expose:

- `measureMcpStartupProfiles(input): McpStartupProfileMeasurementReport`

## Required Behavior

The core implementation must:

1. Accept supplied profile names and supplied public tool definitions or registry entries.
2. Measure each profile deterministically:
   - advertised tool count;
   - facade count;
   - super-tool count;
   - JSON serialized `ListTools` payload bytes;
   - input-schema bytes;
   - description bytes;
   - largest tool definitions by serialized size.
3. Compute deltas against a configurable baseline profile, defaulting to `public-full`.
4. Report reduction ratios and absolute byte deltas.
5. Preserve enough per-tool detail to explain why a profile is large.
6. Return warnings for missing baseline profile, duplicate tool names inside a profile, empty profiles, and invalid byte budgets.
7. Support optional budgets such as max payload bytes and max advertised tools.
8. Return pass/fail budget results without changing runtime behavior.
9. Avoid all MCP server startup, transport access, graph access, database access, file reads, process env reads, timers, random values, or LLM calls.

## Algorithm/Technique

Use a pure serialization and aggregation pipeline:

1. Normalize profile names and tool definitions from supplied input.
2. Sort profiles and tool definitions by stable string keys.
3. For each profile, serialize the same `ListTools` shape the server advertises: `{ tools: [{ name, description, inputSchema }] }`.
4. Count UTF-8 bytes with `TextEncoder` or a deterministic equivalent.
5. Separately count bytes for descriptions and input schemas.
6. Build largest-tool diagnostics sorted by serialized bytes descending, then name.
7. Compare every profile to the baseline profile.
8. Evaluate optional budgets and return structured budget results.

The module must not call `getPublicToolDefinitions()` itself. Runtime adapters and tests can supply definitions from the existing registry.

## Rejected From Core

- Re-implementing startup profile filtering.
- Re-implementing `getMcpStartupProfileToolReport()`.
- Re-implementing `gn_help` or `gn_tool_contract` startup-profile sections.
- Changing the default profile from `public-full` to `core`.
- Strict profile enforcement.
- Schema compaction that changes stable MCP input schemas.
- Warm MCP daemon.
- Facade-first discovery as the default.
- Splitting OntoIndex into multiple MCP servers.
- Measuring wall-clock startup time inside the pure core module.

These can be handled later by release policy, CLI/MCP adapters, or benchmarking scripts after the pure measurement contract exists.

## Later Adapter Opportunities

After the pure module lands, later work may:

- expose measurement output through `gn_tool_contract`;
- add a CLI/report command that prints profile payload deltas;
- add CI snapshots for profile payload size;
- use measurements to decide whether `core` can become the default profile;
- add wall-clock startup benchmarks outside the pure core module.

## Acceptance Criteria

1. `ontoindex/src/mcp/shared/startup-profile-measurement.ts` exists and exports the public types/function above.
2. The implementation is pure and deterministic.
3. Unit tests cover:
   - payload-byte measurement;
   - description/schema byte accounting;
   - baseline deltas;
   - largest-tool diagnostics;
   - duplicate tool warnings;
   - empty profile warnings;
   - budget pass/fail;
   - stable sorting;
   - no server/env/DB/fs/MCP transport dependency.

## Validation Gates

- `cd ontoindex && npm test -- --run test/unit/super/startup-profile-measurement.test.ts`
- `cd ontoindex && npx tsc --noEmit --pretty false`

## Stop Conditions

Stop and re-review the ADR if implementation requires:

- changing profile filtering behavior;
- changing the default startup profile;
- modifying MCP input schemas;
- starting an MCP server;
- reading environment variables;
- measuring wall-clock time inside the core module;
- changing `gn_help`, `gn_tool_contract`, or server dispatch before the pure measurement module exists.
