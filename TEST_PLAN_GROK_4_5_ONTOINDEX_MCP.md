# Test Plan: Grok 4.5 with OntoIndex MCP Tools

Source request: run OntoIndex tools from a sub-agent using the `grok-4.5` model.
Status: FIX IMPLEMENTED IN HOST SOURCE; runtime restart/rebuild verification pending.
Scope: Grok sub-agent compatibility in the Ontocode host. No OntoIndex MCP server change.

## Guiding Constraints

- Use the existing sub-agent model override and existing OntoIndex MCP tools.
- Spawn each test with `fork_context: false`; full-history forks cannot override the parent model.
- Use one OntoIndex tool call per fresh agent until function-call history is proven stable.
- Start with `gn_help`, which does not require a repository query.
- Do not use the SWE-bench eval harness for this smoke test.
- Do not claim compatibility unless an actual OntoIndex MCP result is returned.

## Verified Setup Facts

- `spawn_agent` accepted `model: "grok-4.5"` and reported `effective_model: "grok-4.5"`.
- The first probe attempted to start with `gn_help` and then a repository query.
- The probe failed before returning usable OntoIndex evidence with:
  `ambiguous item between function call and output in provider request history`.
- A second fresh-agent probe requested exactly one `gn_help` call. It failed with a tool registry
  miss and reported the malformed/stale route candidate `mcp__ontoindexgn_help`.
- The identical one-call prompt passed with the inherited control model (`gpt-5.6-sol`) and returned
  an actual `gn_help` MCP result.
- This failure is currently a Grok/sub-agent tool-history compatibility result, not proof of an
  OntoIndex server defect.
- The normal CLI path starts OntoIndex MCP over stdio; the HTTP server also exposes a Streamable HTTP
  MCP endpoint. This sub-agent test uses the tool surface already supplied by the host.

## Issue Report

### Issue 1: Tool Name Route Mismatch

Grok 4.5 may request the plain name `gn_help`, while the active host reports the registered candidate
as `mcp__ontoindexgn_help`. Earlier evidence also showed the delimiterless candidate itself being
requested. The registry previously handled the canonical namespaced form and one flattened form, but
did not safely normalize every observed provider spelling.

Root cause location:
- `/opt/demodb/_workfolder/ontocode/ontocode-rs/core/src/tools/registry.rs`

Required invariant:
- A provider spelling may resolve only when it maps to exactly one registered namespaced tool.
- A real plain tool with the same spelling must win by rejecting the alias as a collision.
- Ambiguous aliases must return a registry miss rather than selecting an arbitrary tool.

### Issue 2: Parallel Tool History Rejected After Assistant Item

The compatible-provider history adapter rejected a later parallel function call when an assistant
item had been deferred between calls. This produced:
`ambiguous item between function call and output in provider request history`.

Root cause location:
- `/opt/demodb/_workfolder/ontocode/ontocode-rs/core/src/client.rs`

Required invariant:
- Assistant items may be moved before the pending call group.
- All pending function calls must remain ordered before their corresponding outputs.
- Existing duplicate, orphan-output, message-boundary, and malformed-history checks must remain active.

## Solutions Considered

### A. Unique Registry Aliases (Selected)

Normalize provider-emitted plain names in the shared tool registry. Accept canonical flattened,
delimiterless MCP, and unqualified names only when resolution is unique and collision-free.

Advantages:
- Fixes all providers at the common lookup boundary.
- Requires no Grok-specific branch or OntoIndex server change.
- Fails closed on ambiguity.

Tradeoff:
- The registry performs a small linear scan over registered tools for non-canonical plain names.

### B. Grok-Specific Request Rewriting

Rewrite Grok tool names before registry lookup.

Rejected because it duplicates registry knowledge in a provider adapter, would require maintenance for
each provider spelling, and could conceal ambiguous aliases.

### C. Change OntoIndex MCP Tool Names

Rename or duplicate MCP tools so Grok's emitted spelling becomes canonical.

Rejected because the control model already reaches the server successfully. The defect is in host
serialization/lookup, not in OntoIndex tool registration.

### D. Prompt-Only Retry

Tell Grok to retry with the registered candidate after a miss.

Retained only as a diagnostic fallback. It is not a fix because the model may emit either observed
spelling and multi-call history can still fail independently.

## Implemented Fix

- `ToolRegistry::resolve_tool_name` now routes plain requests through one resolver.
- The resolver accepts a delimiterless MCP alias such as `mcp__ontoindexgn_help` only when exactly one
  registered namespaced tool matches and no real plain tool owns the spelling.
- Regression tests cover successful lookup, ambiguous aliases, and plain-tool collisions.
- The compatible-provider history guard permits another pending function call after a deferred
  assistant item, while still refusing calls after outputs begin.

## Focused Test Sequence

### 1. Single-Call Tool Discovery

Spawn a fresh isolated sub-agent:

```text
model: grok-4.5
fork_context: false
prompt: Call only the OntoIndex gn_help tool once. Do not call any other tool. Report whether an
actual MCP result was returned and summarize its status and warnings.
```

Pass:
- The agent returns a real `gn_help` result.
- No ambiguous function-call/output history error occurs.

Fail:
- Provider request construction fails before the MCP response is returned.
- The host cannot resolve the tool name or reports a malformed route such as
  `mcp__ontoindexgn_help`.
- The agent describes a tool result without an actual tool invocation.

### 2. Single Repository Query

Run only after Test 1 passes. Spawn another fresh isolated agent and call one read-only query against
a repository name reported by the active OntoIndex service:

```text
Call only gn_explore for the active repository. Query: "Where is the MCP server started?"
Return the top file/symbol evidence and any freshness warning.
```

Pass:
- `gn_explore` returns repository-backed files or symbols.
- The answer includes evidence from the returned result.

Fail:
- The model/tool history error recurs.
- The repository is missing, stale, or incorrectly routed. Record this separately from model failure.

### 3. Two-Call History Check

Run only after Tests 1 and 2 pass independently. In one fresh agent:

1. Call `gn_help`.
2. Call `gn_explore` using the returned repository context.

Pass:
- Both calls return usable results in order.

Fail:
- The second call triggers the baseline ambiguous history error.

This test isolates whether Grok 4.5 can perform one MCP call but cannot preserve a valid
tool-call/tool-result conversation for the next request.

### 4. Control Model Comparison

First repeat Test 1 with the current inherited/default model using the exact same one-call prompt.
If that passes, repeat Test 3 with the same control model.

Interpretation:
- Control passes, Grok fails: model/provider adapter compatibility issue.
- Both fail: host tool-history or OntoIndex MCP integration issue.
- Both pass: baseline failure was transient; repeat Grok three times before closing.

## Evidence to Record

For each run, capture:

- requested and effective model IDs;
- agent ID and timestamp;
- exact OntoIndex tool names called;
- tool route/name emitted by the model or host, when available;
- whether the MCP call returned a result;
- provider/tool error text and which call triggered it;
- repository name and freshness warnings, when applicable;
- returned file/symbol evidence for repository queries.

## Acceptance

- Grok 4.5 completes Test 3 successfully in three consecutive fresh-agent runs.
- At least one repository-backed OntoIndex result is usable and correctly cited by the agent.
- The same prompt passes with the control model.
- No product code or configuration change is required for the smoke-test result.

Implementation acceptance before runtime rollout:
- Registry alias and collision tests pass.
- Compatible-provider request-history regression tests pass.
- Formatting and diff checks pass.
- A rebuilt/restarted host completes the live Grok sequence below.

## Explicitly Out of Scope

- SWE-bench quality or cost comparison.
- Adding a Grok YAML config under `eval/configs/models/`.
- Testing xAI managed Remote MCP directly.
- Adding or changing OntoIndex MCP transports.
- Fixing the provider-history error before the minimal reproduction is confirmed.

## Baseline Result (2026-07-18)

Status: FAILED before usable MCP evidence.

Attempt 1:
- Requested/effective model: `grok-4.5`.
- Intended first tool: `gn_help`.
- Error: `ambiguous item between function call and output in provider request history`.

Attempt 2:
- Requested/effective model: `grok-4.5`.
- Only requested tool: `gn_help`.
- Result: no MCP result returned.
- Error category: tool registry miss / stale tool route.
- Reported route candidate: `mcp__ontoindexgn_help`.

Control attempt:
- Requested model: inherited default.
- Effective model: `gpt-5.6-sol`.
- Only requested tool: `gn_help`.
- Result: actual MCP result returned successfully.
- Top-level `status` and `warnings` fields were absent.

Current interpretation: the OntoIndex MCP tool is available to sub-agents, while Grok 4.5 fails
before reaching it. Treat the minimal reproduction as model/provider tool-name serialization or
routing evidence. Next, inspect the Grok provider request/tool-name adapter; do not change OntoIndex
MCP code unless a direct control-model MCP failure is reproduced.

## Fix Validation Result (2026-07-18)

Source validation used the Rust 1.95 test harness built after the registry changes.

Passed:
- 3 delimiterless MCP alias tests: lookup, ambiguity rejection, and plain-tool collision rejection.
- 12 neighboring `ToolRegistry` handler-resolution tests.
- 1 parallel-call-after-assistant-item regression test.
- 13 neighboring compatible-provider request-construction tests.
- `rustfmt --check` on the four touched Rust files under Rust 1.95.
- `git diff --check` in the Ontocode worktree.

Workspace formatting note:
- `cargo fmt --all -- --check` exited 1 without diagnostics in the already-dirty workspace.
- Direct `rustfmt --check` on the four changed files exited 0; only the repository's existing
  stable-channel warning about `imports_granularity` was emitted.

Live post-source probe:
- Agent: `019f7670-7635-7d53-925e-0a18a06544f8`.
- Requested/effective model: `grok-4.5`.
- Requested tool: plain `gn_help`.
- Result: registry miss; active candidate reported as `mcp__ontoindexgn_help`.
- Interpretation: the running sub-agent host still uses the pre-fix binary. This does not invalidate
  source tests, but runtime compatibility remains unproven until the host is rebuilt and restarted.

OntoIndex graph note:
- A fresh `gn_explore` call against repository label `codex` timed out while loading the FTS
  extension. Exact implementation claims above were therefore verified directly from source.

## Runtime Rollout Check

After rebuilding and restarting the Ontocode host:

1. Run one fresh `grok-4.5` agent with exactly one `gn_help` call.
2. Run one fresh agent with exactly one `gn_explore` call.
3. Run one fresh agent with `gn_help` followed by `gn_explore`.
4. Repeat step 3 three times before declaring compatibility.

Do not close the issue if the running binary still reports either plain `gn_help` or
`mcp__ontoindexgn_help` as an unsupported call.
