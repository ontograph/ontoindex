# ADR 0027: MCP Startup Surface Profiles and Lazy Tool Loading

Status: Proposed - Challenged

## Context

OntoIndex now exposes a large MCP frontier. The public server currently advertises dozens of
super-functions plus facade tools, and the startup path serializes every public tool definition.
That is useful for discoverability, but expensive for agents that only need the common workflow:
inspect project state, ask for help, query code, check safety, and then request a more specific
tool only when needed.

The current architecture also has two different startup costs:

1. **Discovery payload cost:** the MCP `ListTools` response includes all public tool schemas,
   descriptions, and metadata.
2. **Runtime module-load cost:** the super-function dispatcher imports many implementations
   eagerly, even when a session never calls those tools.

ADR 0025 already created the tool contract registry and drift gates. ADR 0026 added evidence
classification and organic-recommendation guardrails. Any startup optimization must preserve those
contracts instead of introducing a parallel tool system.

Current source review found two important implementation facts:

- `createMCPServer()` currently builds the advertised MCP frontier from
  `getPublicToolDefinitions()` in normal mode, while `options.full` switches to
  `INTERNAL_TOOL_HANDLERS`.
- `server.ts` imports `dispatchSuper` from `super/dispatch.ts` at module load time, and
  `dispatch.ts` statically imports the super-function implementation modules.

Therefore profile filtering alone can reduce the `ListTools` response, but it will not reduce all
startup cost until the eager `dispatchSuper` import path is changed.

## Decision

Adopt **profiled MCP startup surfaces** as the first optimization, then add **lazy super-function
handler loading** behind the existing dispatcher.

The default agent-facing MCP server should advertise a small, organic default profile while keeping
the complete public tool set available through an explicit `public-full` profile. The implementation must keep
`gn_tool_contract`, `gn_help`, and the registry as the source of truth, so startup shrinkage is a
filtered view of the same public contract, not a second contract.

## Recommended Implementation

### 1. Add MCP startup profiles

Introduce a profile selector, for example:

```text
ONTOINDEX_MCP_STARTUP_PROFILE=core|query|audit|refactor|systems|public-full
```

Recommended profile meanings:

| Profile | Advertised tools | Intended user |
| --- | --- | --- |
| `core` | facades, `gn_help`, `gn_tool_contract`, `gn_diagnose`, freshness/safety basics | default agent startup |
| `query` | core plus code/docs/query/navigation tools | exploration sessions |
| `audit` | core plus review, evidence, replay, verification, systems-audit tools | audit sessions |
| `refactor` | core plus impact, safe-edit, rename/refactor tools | code-change sessions |
| `systems` | core plus lifecycle, FD, fork, signal, taint, ABI, and resource tools | systems audits |
| `public-full` | current public frontier | compatibility and power users |

Avoid naming this profile `full`. In the current server implementation, `options.full` means the
legacy/internal MCP handler set, not the normal public super-function frontier. Reusing `full` would
make release notes and support diagnostics ambiguous.

The default should be `core` only after compatibility has been tested. Until then, use
`public-full` as the default and let agents opt into `core` with an environment variable.

Do not create a completely separate policy axis if the existing registry modes can carry the same
meaning. The first implementation should map startup profiles onto existing `AgentMode` metadata
where possible:

| Startup profile | Existing registry mode relationship |
| --- | --- |
| `query` | likely maps to `query-projects` plus facades |
| `audit` | maps to `audit` |
| `refactor` | maps to `refactor` |
| `public-full` | no mode filter |
| `core` | small allowlist, because no current `AgentMode` means "minimal bootstrap" |
| `systems` | probably needs new metadata or category filtering because current modes do not isolate systems-audit tools |

### 2. Keep hidden tools callable during the migration

In the first slice, profile filtering should only change the advertised `ListTools` response. The
dispatcher may still accept calls to tools that are hidden by the current profile. This avoids
breaking existing agents that know exact tool names while still shrinking startup payload for agents
that rely on discovery.

After telemetry and tests prove compatibility, a later release may add strict profile enforcement.
Strict enforcement must be explicit and separately documented.

Challenge: hidden-but-callable tools must not become a permanent bypass around discovery and
permission expectations. `gn_tool_contract` should report this as `enforcement: "advertise_only"`
and expose the hidden callable names or counts so users can tell whether a session is operating in a
compatibility mode.

### 3. Report profile state through existing contracts

Extend `gn_tool_contract` and `gn_help` to show:

- active profile;
- advertised tool count;
- hidden-but-callable tool count;
- full public tool count;
- whether facade tools are included;
- whether the current server is running in compatibility mode or strict profile mode.

This keeps ADR 0025 drift checks useful even when different sessions advertise different frontiers.

### 4. Lazy-load super-function handlers

After profile filtering lands, replace eager dispatcher imports with a lazy handler registry. The
dispatcher should load an implementation module only when that tool is called.

This targets the second startup cost. Profile filtering reduces `ListTools` payload; lazy loading
reduces cold module initialization.

The lazy-loading implementation must start at `server.ts`, not only inside `dispatch.ts`. If
`server.ts` continues to statically import `dispatchSuper` from `super/dispatch.ts`, Node will still
evaluate `dispatch.ts` and its implementation imports during server startup. The first lazy-loading
slice should either:

1. move `SUPER_NAMES` to a small name-only registry module and dynamically import `dispatchSuper`
   only on a super-tool call; or
2. rewrite `dispatch.ts` so its top-level imports are type-only or name-only and each case performs
   a dynamic import.

The first option has the cleaner startup boundary because `server.ts` can answer `ListTools`
without evaluating super-function implementations.

### 5. Compact default-profile schemas

For default startup only, use concise descriptions and avoid embedding nonessential explanatory
metadata where MCP clients do not need it up front. Full details should remain available through
`gn_tool_contract` or the `public-full` profile.

Do not remove properties from stable JSON input schemas as a startup shortcut. That would change how
MCP clients discover valid arguments and could conflict with ADR 0025 snapshot expectations. Schema
compaction is acceptable only if it preserves the stable validation contract or is implemented as a
separate abbreviated discovery layer.

## Review and Challenge

Reviewed on 2026-05-23 against the current OntoIndex MCP implementation.

Evidence:

- `gn_diagnose({repo: "OntoIndex", checkToolContract: true})` reported a stale index but a clean MCP
  tool contract: 51 advertised super-functions and 8 facade tools.
- `gn_tool_contract({includeFacades: true})` reported no missing or extra callable tools in the
  active MCP session.
- Direct source review found `server.ts` advertises `getPublicToolDefinitions()` in normal mode and
  routes super-functions through the statically imported `dispatchSuper`.
- Direct source review found `tool-registry.ts` already has `AgentMode` filtering and
  `getPublicToolDefinitions(options)`, so startup profiles should extend that registry rather than
  inventing a second public-tool list.
- Direct source review found `super/dispatch.ts` statically imports every super-function
  implementation module, so true module-load savings require a dispatcher import boundary change.

Challenge findings:

1. **Profile naming must avoid existing `full` semantics.** Use `public-full` for the current public
   super/facade frontier. Keep `options.full` reserved for the existing internal handler path unless
   that path is renamed in a separate migration.
2. **Do not duplicate `AgentMode` without a reason.** Most proposed profiles map to existing
   registry modes. Only `core` and maybe `systems` need new selection logic.
3. **Advertise-only compatibility needs an exit plan.** Hidden-but-callable tools are useful for
   migration, but they must be visible in contracts and should not silently become the long-term
   permission model.
4. **Lazy loading must remove the `server.ts -> dispatch.ts` eager edge.** A lazy registry inside
   `dispatch.ts` is insufficient if the server still imports the dispatcher at startup.
5. **Schema compaction is risky.** Stable input schemas are part of the MCP contract. Reduce
   descriptions and metadata first; abbreviate schemas only if the validation contract remains
   unchanged or the abbreviated form is clearly separate from the stable schema.
6. **Measurement must gate default changes.** Do not switch the default from `public-full` to `core`
   until payload bytes, startup time, and agent task success are measured on representative sessions.

## Why Facade-First Is Deferred

Facade-first discovery is useful, but it should not be the first slice.

Reasons:

1. It changes the product contract more than it changes startup mechanics.
2. It can hide important OntoIndex intent boundaries unless routing explanations are excellent.
3. It risks weakening ADR 0018, ADR 0025, and ADR 0026 trust boundaries if facade output does not
   expose evidence class, freshness, provenance, and recommendation authority.
4. It does not reduce module-load cost by itself if the dispatcher still imports all handlers.
5. It needs a compatibility period because some agents use exact tool names.

Recommendation: use facades heavily inside the `core` profile, but do not remove direct tools from
the `public-full` profile. Revisit facade-first as a phase 2 cleanup after profile filtering and lazy
loading are measured.

## Why Warm Daemon Is Deferred

A warm MCP daemon could reduce repeated process cold starts, but it does not reduce the large
tool-list/schema payload. It also introduces lifecycle risks:

- stale index or stale runtime state;
- cross-session state leakage;
- process supervision complexity;
- harder provenance and source-identity debugging;
- more failure modes around shutdown and workspace switching.

Recommendation: consider a warm daemon only if measured startup remains too slow after profiles,
lazy imports, and schema compaction. If added, it must report runtime source identity and freshness
through `gn_diagnose` and `gn_tool_contract`.

## Alternatives Considered

### Keep the current public frontier

Rejected as the only default. It maximizes discoverability but keeps startup expensive for every
agent session, including sessions that only need a few tools.

### Split OntoIndex into multiple MCP servers

Deferred. Separate servers can reduce per-session tool count, but they increase installation,
configuration, and support burden. Profiles provide most of the benefit inside the existing server.

### Remove low-use tools from public MCP

Rejected. Low-use tools may still be important for specific audits. The problem is startup
advertisement, not necessarily tool existence.

### Build a new agent router

Rejected for this ADR. OntoIndex already has facades, `gn_help`, `gn_tool_contract`, and the registry.
A new router would duplicate responsibility and weaken the existing contract model.

## Implementation Plan

1. Add profile metadata and a profile filter to `ontoindex/src/mcp/shared/tool-registry.ts`.
2. Update `createMCPServer` list-tools behavior to use the active profile.
3. Extend `gn_tool_contract` with active-profile and hidden-tool reporting.
4. Extend `gn_help` to explain how to switch profiles and discover the full frontier.
5. Add focused tests for profile counts, facade inclusion, full-profile parity, and contract output.
6. Move super-tool name discovery out of `super/dispatch.ts` so `server.ts` can avoid eager
   dispatcher imports during startup.
7. Convert super-function dispatcher implementation imports to lazy imports.
8. Add timing/payload measurements before and after profile and lazy-load changes.

## Implementation Guardrails

- Treat `public-full` as a filtered view of the ADR 0025 registry, not a new registry.
- Keep `INTERNAL_TOOL_HANDLERS` and legacy `options.full` behavior out of the startup-profile
  contract unless a later ADR explicitly migrates it.
- Keep `core` small enough to matter. A useful first target is facades plus
  `gn_help`, `gn_tool_contract`, `gn_diagnose`, `gn_ensure_fresh`, and `gn_quality_mode`.
- Do not add strict enforcement until advertise-only compatibility has a measured migration window.
- Do not allow profile filtering to alter ADR 0026 evidence classification or organic recommendation
  authority.

## Acceptance Criteria

- Default profile can advertise a substantially smaller tool frontier.
- `public-full` profile preserves the current public MCP surface.
- `gn_tool_contract` reports no registry drift in every profile.
- Hidden tools remain callable during the migration period.
- ADR 0026 evidence classes and organic-recommendation guardrails are unchanged.
- Lazy imports do not change handler behavior or structured output envelopes.
- Startup payload size and server initialization time are measured before and after the change.
- `server.ts` can answer `ListTools` for a small profile without loading all super-function
  implementation modules.

## Validation

For code changes that implement this ADR, run:

```bash
cd ontoindex && npx tsc --noEmit --pretty false
cd ontoindex && npx vitest run test/unit/super/tool-contract.test.ts test/unit/super/help.test.ts test/unit/tool-contract-schema.test.ts
cd ontoindex && npm run build
```

Before commit, also run the OntoIndex pre-commit audit and inspect changed symbols through the
OntoIndex change detector required by the project instructions.

## Consequences

Pros:

- Smaller default MCP startup payload.
- Lower cognitive load for agents.
- Full compatibility path remains available.
- ADR 0025 registry remains the source of truth.
- Lazy loading can reduce cold process cost without changing tool contracts.

Cons:

- Tool discovery becomes profile-dependent.
- Tests must cover multiple frontiers instead of one.
- Help and contract output need to explain hidden-but-callable tools clearly.
- Strict enforcement, if added later, will require a separate compatibility decision.
