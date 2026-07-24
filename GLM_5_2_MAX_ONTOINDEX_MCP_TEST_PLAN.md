# GLM 5.2 Max - OntoIndex MCP Test Plan and Results

Status: FAIL on installed host; flattening remediation exists in the dirty source tree and focused tests pass, but rebuild/restart and live rerun are pending
Date: 2026-07-18
Last run: 2026-07-18T19:43:29Z
Owner: OntoIndex maintainers
Template: `KIMI_K3_ONTOINDEX_MCP_SMOKE_TEST_PLAN.md`

## 1. Purpose

Verify that a fresh sub-agent requested as `glm-5.2-max` can call OntoIndex MCP tools and use
repository-scoped evidence. Separately verify, when authoritative host telemetry exists, whether the
alias maps to provider model `glm-5.2` with maximum reasoning effort.

This is a compatibility smoke test, not a quality benchmark. Model launch, provider mapping, MCP
tool provisioning, tool execution, history serialization, and answer grounding are separate gates.

## 2. Verified Integration Facts

- The active sub-agent runner accepts `model: "glm-5.2-max"` and reports
  `effective_model: "glm-5.2-max"`.
- Spawn metadata does not expose the outbound provider model or reasoning-effort fields. It cannot
  prove that the alias maps to `glm-5.2` plus `reasoning_effort: "max"`.
- No checked-in eval config names `glm-5.2-max`. The SWE-bench harness defines only `glm-5` as
  `openrouter/zhipuai/glm-5` in `eval/configs/models/glm-5.yaml`.
- Z.AI documents the API model as `glm-5.2`; `max` is a reasoning-effort value rather than a separate
  provider model ID.
- OntoIndex MCP package `2.0.10` reports startup profile `public-full`, 61 public tools, and a clean
  advertised/callable contract.
- `gn_tool_contract({mode: "query-projects", includeFacades: true})` confirms `gn_help` and `inspect`
  are host-visible and callable in the parent/control environment.
- Indexed HEAD and target HEAD are both `8bcdc39efb503fd2725fe8796e6d405de3ecf2f2`.
- The wider worktree is dirty, but `ontoindex/src/mcp/server.ts` is clean, so the deterministic target
  evidence is not affected by an unindexed edit to that file.
- The installed `/home/evrasyuk/.local/bin/ontocode` binary was built at `2026-07-18 07:28:03Z`.
- The provider namespace-remediation source files were modified at `2026-07-18 10:29:06Z`, and flat
  registry dispatch was modified at `2026-07-18 17:43:35Z`. The running host therefore cannot contain
  the current remediation.
- Current dirty source classifies non-official OpenAI-compatible endpoints as
  `ToolNamespaceEncoding::Flattened`, emits namespaced tools as flat function names, and resolves
  unique flat calls back to the original registered handlers.

## 3. Runner Contract

### Current Live Runner

The 2026-07-18 run used `multi_agent_v1.spawn_agent` with:

```text
model: glm-5.2-max or inherit
fork_context: false
agent_type: default
```

The tool returns authoritative requested/effective host model IDs and an agent ID. Agent completion
notifications contain the final answer and summarized tool outcome. This runner does not expose:

- provider request/response payloads;
- alias-to-provider routing telemetry;
- effective reasoning effort;
- a strict per-agent tool allowlist parameter;
- raw serialized assistant/tool history or persistent transcript paths.

Therefore provider-mapping gates are `NOT OBSERVABLE`, and history serialization can be graded only
after the first MCP call succeeds. A repeatable automated runner remains required before this test
can be promoted to CI.

### Required Automated Runner

A future runner must persist under a documented results directory:

1. spawn metadata with requested/effective host model;
2. outbound provider request and provider response model identity;
3. exact tool definitions sent to the model;
4. raw assistant tool calls, call IDs, tool results, and second outbound request;
5. runner-assigned gate results and exit code.

Exit codes: `0` pass, `1` compatibility fail, `2` blocked precondition, `3` runner/infrastructure
error.

## 4. Preconditions

- The exact alias is accepted by the host runner.
- Indexed HEAD equals target HEAD.
- `ontoindex/src/mcp/server.ts` is clean; unrelated dirty files are warnings only.
- `gn_tool_contract({mode: "query-projects", includeFacades: true})` reports no drift and confirms
  both `gn_help` and `inspect` are host-visible.
- A known-working inherited control model passes the same prompt in the same host session.
- Agent prompts forbid shell, direct reads, web, generic resource reads, discovery/catalog fallback,
  repository writes, and extra tool calls.

Provider identity and reasoning effort are not preconditions for the MCP sub-verdict when the runner
cannot observe them. They remain mandatory for the separate provider-mapping verdict.

## 5. Corrected Rerun Prompts

These prompts incorporate the independent challenge and were not the exact prompts used in the
2026-07-18 live run. The historical run used path/symbol output fields and summarized completion
notifications; it proved control reachability and GLM provisioning failure, but not raw grounding or
history fidelity.

### 5.1 Tool Discovery

```text
Call only `mcp__ontoindex.gn_help` once with:
{"repo":"ontoindex","mode":"query-projects","limit":5}

Return the actual tool name, whether a real MCP result returned, active startup profile, advertised
tool count, and exact error. Do not use discovery/catalog fallback or grade the run.
```

### 5.2 Repository Evidence

```text
Call only `mcp__ontoindex.inspect` once with:
{"action":"context","repo":"ontoindex","name":"createMCPServer","include_content":false,"limit":5}

Return the actual tool name and arguments plus response-only fields `uid`, `startLine`, and `endLine`.
Do not return expected values supplied by the prompt and do not grade the run.
```

The runner, not the prompt, compares the raw MCP result with the agent answer. The prompt must not
disclose the expected source path or line range.

### 5.3 Sequential History

```text
1. Call `mcp__ontoindex.gn_help` once with
   {"repo":"ontoindex","mode":"query-projects","limit":5}.
2. After its result, call `mcp__ontoindex.inspect` once with
   {"action":"context","repo":"ontoindex","name":"createMCPServer","include_content":false,"limit":5}.
3. Return the two actual tool names in order and response-only inspect fields.

Do not use discovery/catalog fallback, run calls in parallel, or grade the run. Stop if call 1 fails.
```

When raw history is available, the runner must also verify that the second provider request contains
the unchanged first assistant tool call, matching tool-result ID, unchanged first result, required
reasoning metadata, and the second call only after that result.

## 6. Test Cases

| ID | Check | Pass condition |
|---|---|---|
| GLM-00 | Alias launch | Runner accepts and reports requested/effective host model as `glm-5.2-max`. |
| GLM-01 | Provider identity | Authoritative outbound request or gateway telemetry records provider model `glm-5.2`. |
| GLM-02 | Reasoning setting | Authoritative outbound request records reasoning effort `max`. |
| GLM-03 | Harness control | Inherited control returns real MCP results for discovery, repository evidence, and sequential reachability in the same host session. |
| GLM-04 | Tool provisioning | Required OntoIndex tools are present in the GLM agent's actual tool surface. |
| GLM-05 | Tool discovery | GLM returns a real `gn_help` MCP result. |
| GLM-06 | Repository scope | GLM `inspect` result identifies repository `ontoindex`. |
| GLM-07 | Code evidence | GLM `inspect` returns the requested symbol definition evidence. |
| GLM-08 | Answer grounding | Response-only fields exactly match the same run's raw MCP result. |
| GLM-09 | Sequential history | Both calls succeed; raw second-request history invariants pass when observable. |
| GLM-10 | No fallback or writes | No discovery/catalog, resource, shell, read, web, write, parallel, or extra call occurs. |
| GLM-11 | Repeatability | Test 5.3 passes in three consecutive fresh GLM agents. |

## 7. Acceptance and Verdicts

Maintain two verdicts:

- **MCP compatibility:** `PASS` only when `GLM-00` and `GLM-03` through `GLM-11` pass. `FAIL` when
  controls pass but a GLM MCP gate fails. `BLOCKED` only when the control or repository precondition
  fails.
- **Provider mapping:** `PASS` only when `GLM-01` and `GLM-02` have authoritative request telemetry.
  Otherwise `NOT OBSERVABLE`; do not infer it from the alias or model self-report.

Do not classify a first-call provisioning failure as a history-serialization failure. `GLM-09` is
`NOT REACHED` until `gn_help` succeeds.

## 8. Independent Challenge

An inherited-model reviewer challenged the original plan before results were incorporated.

| Severity | Finding | Correction applied |
|---|---|---|
| Critical | The plan named an abstract runner with no command, artifacts, or exit codes. | Added the current live-runner limits and required automated-runner contract. |
| Critical | Provider identity and reasoning gates assumed unavailable metadata. | Split MCP and provider-mapping verdicts; mark missing telemetry `NOT OBSERVABLE`. |
| High | Call order alone did not prove serialized history correctness. | Added call-ID, unchanged-result, reasoning-metadata, and second-request invariants. |
| High | Tool-contract preflight could omit the `inspect` facade. | Require query-projects mode with facades included and explicit visibility assertions. |
| High | HEAD equality allowed dirty target evidence. | Require `ontoindex/src/mcp/server.ts` to be clean. |
| High | Expected path leaked through the prompt, weakening grounding. | Grade response-only UID/line fields against raw MCP output. |

## 9. Live Results - 2026-07-18

### 9.1 Environment Preflight

| Check | Result |
|---|---|
| MCP package | `ontoindex` `2.0.10` |
| Startup profile | `public-full` |
| Public advertised tools | 61 |
| Tool contract | PASS; no missing or extra tools |
| Query-projects facade check | PASS; `inspect` host-visible and callable |
| Target/indexed HEAD | `8bcdc39efb503fd2725fe8796e6d405de3ecf2f2` |
| Target file clean | PASS: `ontoindex/src/mcp/server.ts` has no worktree change |
| Wider worktree | Dirty; unrelated to the target evidence |

### 9.2 Agent Runs

| Run | Agent ID | Requested/effective model | Result |
|---|---|---|---|
| Independent challenge | `019f76aa-35f2-7382-a0eb-78cba54c8c91` | inherited / `gpt-5.6-sol` | Completed; six plan defects found |
| Control 5.1 | `019f76aa-3632-7362-9c10-6c284f8937d6` | inherited / `gpt-5.6-sol` | PASS: real `gn_help`, `public-full`, 61 tools |
| Control 5.2 | `019f76aa-f6dc-7460-9bc7-b779d94d9054` | inherited / `gpt-5.6-sol` | PASS for reachability: repository/symbol/path returned; raw UID/line grounding not tested |
| Control 5.3 | `019f76aa-f75f-72e0-ae9a-f42e5a6ad322` | inherited / `gpt-5.6-sol` | PASS: `gn_help` then `inspect` |
| GLM 5.1 | `019f76aa-3671-71a0-929c-cf1ee8960a79` | `glm-5.2-max` / `glm-5.2-max` | FAIL: no MCP servers available |
| GLM 5.2 | `019f76aa-36b2-7313-ada1-e63d65be173e` | `glm-5.2-max` / `glm-5.2-max` | FAIL: no MCP servers available |
| GLM 5.3 run 1 | `019f76aa-3708-7af2-b818-1ff35074d577` | `glm-5.2-max` / `glm-5.2-max` | FAIL at call 1; discovery fallback attempted |
| GLM 5.3 run 2 | `019f76aa-3c5f-77d2-81dc-87d09e0434f6` | `glm-5.2-max` / `glm-5.2-max` | FAIL at call 1; catalog/pattern discovery attempted |
| GLM 5.3 run 3 | `019f76aa-f79a-72e1-b2e1-ac85676ed4d7` | `glm-5.2-max` / `glm-5.2-max` | FAIL at call 1; stopped without fallback |

Direct GLM calls consistently returned:

```text
MCP server does not exist: ontoindex. No MCP servers available.
Use GetMcpTools to discover available servers.
```

The controls prove OntoIndex MCP is healthy and reachable in inherited sub-agents. The GLM results
prove that the installed host launches the model alias but gives GLM no usable OntoIndex call path.
They do not by themselves distinguish an empty child session manager from provider-side loss of
native namespace declarations because the runner did not capture the exact tool schema sent to GLM.

### 9.3 Gate Results

| Gate | Result | Evidence |
|---|---|---|
| GLM-00 | PASS | All GLM spawns reported requested/effective `glm-5.2-max`. |
| GLM-01 | NOT OBSERVABLE | Spawn metadata has no provider request identity. |
| GLM-02 | NOT OBSERVABLE | Spawn metadata has no reasoning-effort field. |
| GLM-03 | PASS | All three inherited controls returned real MCP results; raw grounding/history fidelity remains outside this gate. |
| GLM-04 | FAIL | GLM agents reported zero MCP servers; required tools were absent. |
| GLM-05 | FAIL | GLM `gn_help` never reached OntoIndex. |
| GLM-06 | FAIL | No GLM `inspect` repository result returned. |
| GLM-07 | FAIL | No GLM code evidence returned. |
| GLM-08 | NOT REACHED | No successful GLM MCP result existed to ground an answer. |
| GLM-09 | NOT REACHED | All sequential runs failed on call 1; history serialization was not exercised. |
| GLM-10 | FAIL | Runs 1 and 2 attempted forbidden discovery/catalog fallback; run 3 complied. |
| GLM-11 | FAIL | Three consecutive fresh sequential runs failed at call 1. |

Final verdicts:

```text
MCP COMPATIBILITY: FAIL
PROVIDER MODEL/REASONING MAPPING: NOT OBSERVABLE
ONTOINDEX SERVER/CONTROL PATH: PASS
FAILURE CLASS: STALE HOST PLUS MODEL/PROVIDER TOOL-ENCODING INCOMPATIBILITY
```

## 10. Failed-Call Review and Root Cause

### 10.1 Reproduction

A fresh `glm-5.2-max` capability sub-agent reproduced the historical result:

```text
GetMcpTools catalog: servers = []
GetMcpTools pattern search: matches = []
CallMcpTool(ontoindex, search):
MCP server does not exist: ontoindex. No MCP servers available.
```

The same parent session can call OntoIndex directly, and inherited-model controls pass. OntoIndex
server startup, repository indexing, and public tool registration are therefore not the failing
boundary.

### 10.2 Corrected Source Diagnosis

The earlier hypothesis that `ProviderCapabilities::default()` disables namespaces is false. At the
indexed source revision it sets `namespace_tools: true`. Current dirty source replaces that boolean
with `ToolNamespaceEncoding::{Native, Flattened}` and defaults to `Native`.

The material facts are:

1. `glm-5.2-max` is a model slug, not a production provider mapping in the checked source. Provider
   behavior is selected independently from `ModelProviderInfo` and `model_provider_id`.
2. The installed host treats custom OpenAI-compatible providers as native-namespace capable. A GLM
   proxy that does not preserve the Responses API namespace object can therefore lose direct MCP tool
   declarations before the model sees them.
3. Current dirty source addresses this by using `Flattened` encoding for non-official
   OpenAI-compatible endpoints. For example, `mcp__ontoindex.inspect` becomes the plain function
   `mcp__ontoindex__inspect`, while the registry retains the original server/tool routing.
4. Child construction passes the shared `McpManager`, and each turn reads its session
   `McpConnectionManager` with `has_servers()` and `list_all_tools()`. Manager inheritance is plausible
   from source but remains unproven at runtime until telemetry records the GLM child's server/tool
   counts.
5. `GetMcpTools` and `CallMcpTool` are not Ontocode handlers backed by the session manager. No local
   executable implementation or alias exists for those names. They appear to be an external
   provider/host convention and must not be treated as evidence that the session MCP inventory is
   empty.

### 10.3 Evidence Confidence

| Claim | Confidence | Evidence |
|---|---|---|
| OntoIndex server is healthy | Proven | Parent calls and inherited controls pass. |
| GLM generic MCP catalog is empty | Proven | Fresh GLM capability reproduction and all historical GLM runs. |
| Running host lacks the current flattening fix | Proven | Installed binary timestamp predates all remediation source changes. |
| Current source flattens non-official OpenAI-compatible namespaces | Proven | Provider descriptor, spec planner, registry source, and focused tests. |
| GLM child session manager is empty | Not proven | No child `has_servers()` or `list_all_tools()` telemetry was captured. |
| Alias maps to provider model `glm-5.2` with reasoning `max` | Not observable | Current runner exposes neither provider payload nor effective effort. |

## 11. Ranked Solution Options

### Solution 1 - Build, Install, Restart, and Rerun Current Flattening Fix

**Priority: recommended first.** The smallest credible remedy already exists in the dirty source tree:

- classify non-official OpenAI-compatible providers as `Flattened`;
- emit collision-safe flat tool functions instead of native namespace objects;
- resolve flat calls to the existing namespaced MCP handlers;
- omit ambiguous flat names;
- disable namespace-dependent `tool_search` for flattened providers so MCP tools remain direct.

Required action:

1. Fix the unrelated current-tree Rust compile error described in Section 12.3.
2. Build and install a new `ontocode` binary from the reviewed source.
3. Fully restart the host; restarting only the OntoIndex MCP process is insufficient.
4. Capture the GLM request tool schema and confirm `mcp__ontoindex__gn_help` or
   `mcp__ontoindex__inspect` is present as a flat function.
5. Run Section 5.1 and 5.2 once, then Section 5.3 three times.

Advantages: reuses existing handlers, approvals, tracing, filtering, and result serialization; graph
impact is low around provider selection and spec planning. Risk: flattened providers cannot currently
use namespace-dependent deferred `tool_search`, so very large MCP inventories are sent directly and
need a size-limit test.

### Solution 2 - Add Provider-Specific Capability Configuration

Add explicit provider configuration for tool namespace encoding instead of inferring it only from the
base URL. Configure the real GLM provider route as `Flattened` and retain `Native` only for endpoints
known to preserve namespace objects.

Advantages: avoids endpoint heuristics and supports proxies with unusual URLs. Risks: requires an
authoritative GLM provider ID/configuration source, which is not present in this repository; a global
change to every OpenAI-compatible provider would be unsafe.

### Solution 3 - Add Generic MCP Compatibility Handlers

Implement provider-gated `GetMcpTools` and `CallMcpTool` handlers backed by the same session
`McpConnectionManager`. Listing must use the effective filtered tool inventory. Calls must enter the
existing `handle_mcp_tool_call` path so approvals, authentication elicitation, sandbox metadata,
tracing, hooks, timeouts, and result sanitization are preserved.

Advantages: supports models that insist on generic MCP operations and removes the apparent split
between provider-native and session MCP catalogs. Risks: larger implementation and security surface;
the provider-side argument schema is not captured; direct client calls would bypass required policy.
Do not start with changes to `McpConnectionManager::list_all_tools()` or broad registry behavior.

### Solution 4 - Instrument Child MCP and Provider Requests

Add bounded diagnostics before sampling:

- child session source, model, and provider ID;
- namespace encoding;
- `has_servers()` and server names;
- raw/effective MCP tool counts;
- direct/deferred/omitted counts and collision reasons;
- exact model-visible tool names;
- provider response tool name and registry resolution result.

This is a diagnostic solution, not the user-facing fix. It is required if Solution 1 still fails
after restart because it distinguishes manager inheritance failure from request serialization loss.

### Solution 5 - Parent-Controlled Operational Workaround

Keep OntoIndex calls in the known-working parent/control model and provide bounded results to GLM as
input. This requires no host change but does not establish GLM MCP compatibility and must not be
graded as a pass for this plan.

## 12. Delegated Test Results

### 12.1 Focused Provider Tests

An independent worker ran eight `ontocode-model-provider` unit tests covering default capabilities,
custom OpenAI-compatible providers, official endpoint handling, runtime override behavior, provider
selection, and authentication capability preservation.

```text
8 passed, 0 failed
```

### 12.2 Focused Flattening and Dispatch Tests

An independent worker ran the current test binary against these exact behaviors:

- OpenAI-compatible proxy flattens MCP namespaces and disables `tool_search`;
- duplicate flattened names are omitted;
- flattened/plain-name collisions are omitted;
- registered flat MCP names resolve;
- flat MCP names dispatch to the registered namespaced handler.

```text
5 passed, 0 failed
```

Additional independent executions passed delimiterless flat MCP lookup, ambiguous-name rejection, and
one MCP metadata round trip. These overlap the focused suite and are supporting evidence, not added to
the primary pass count.

### 12.3 Validation Blockers and Failures

| Check | Result | Meaning |
|---|---|---|
| Current-tree `cargo test` compile | BLOCKED | Exit 101: a non-`Send` future around `core/src/session/turn.rs:332` is surfaced from `core/src/tasks/regular.rs:42`. The GLM integration test did not execute. |
| `remote_models_glm_5_2_max_custom_provider_tool_round_trip` | NOT RUN | Blocked by the compile error above. Existing test covers a plain shell function, not an MCP flat-function round trip. |
| MCP approval metadata prebuilt test | FAIL | Process aborted with a `tokio-runtime-worker` stack overflow; investigate separately before broad MCP regression sign-off. |
| Live rebuilt-host GLM smoke | NOT RUN | Installed binary predates remediation; restart without rebuilding cannot validate it. |

Passing prebuilt unit binaries were built after the relevant remediation test files changed, but they
do not replace a clean current-source build. The remediation is therefore **unit-supported but not yet
integration-validated**.

## 13. Required Remediation and Rerun

1. Repair the unrelated non-`Send` compile failure without changing MCP behavior.
2. Add or strengthen one GLM custom-provider integration test that installs a mock MCP tool, verifies
   the flat request declaration, returns a flat tool call, and proves dispatch reaches the original
   MCP handler.
3. Investigate the MCP approval metadata stack overflow or prove it is isolated from the changed path.
4. Build and install the current flattening implementation, then fully restart the host.
5. Before GLM execution, assert the actual child tool surface contains the expected flat OntoIndex
   tools and record child `has_servers()` plus effective MCP tool count.
6. Rerun Section 5.1 and 5.2 once. Only after both pass, rerun Section 5.3 three times.
7. Capture raw second-request history before claiming sequential tool-history compatibility.
8. Add provider model/reasoning telemetry, or invoke canonical `glm-5.2` with explicit maximum
   reasoning when the host API supports an authoritative setting.

Do not change OntoIndex MCP server code based on this result. The identical controls reached the
current server successfully; the failure occurs before a GLM tool call reaches OntoIndex.

## 14. Optional Eval Harness Follow-Up

Only after the live MCP smoke test passes, add a separate eval YAML if benchmark comparison is
needed. Do not change `glm-5.yaml`, and confirm the exact LiteLLM/OpenRouter model string first. The
eval harness measures task performance; it does not replace live MCP compatibility evidence.

## 15. References

- Z.AI, `GLM-5.2`: https://docs.z.ai/guides/llm/glm-5.2
- Z.AI, `Deep Thinking`: https://docs.z.ai/guides/capabilities/thinking
- Repository template: `KIMI_K3_ONTOINDEX_MCP_SMOKE_TEST_PLAN.md`
- Existing eval config: `eval/configs/models/glm-5.yaml`
- Host provider capabilities: `/opt/demodb/_workfolder/ontocode/ontocode-rs/model-provider/src/provider.rs`
- Host provider descriptor: `/opt/demodb/_workfolder/ontocode/ontocode-rs/model-provider/src/descriptor.rs`
- Host tool spec planning: `/opt/demodb/_workfolder/ontocode/ontocode-rs/core/src/tools/spec_plan.rs`
- Host tool registry: `/opt/demodb/_workfolder/ontocode/ontocode-rs/core/src/tools/registry.rs`
- Host turn MCP inventory: `/opt/demodb/_workfolder/ontocode/ontocode-rs/core/src/session/turn.rs`
