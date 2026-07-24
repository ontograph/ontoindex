# Kimi K3 - OntoIndex MCP Sub-Agent Smoke Test Plan

Status: Implemented; live control and Kimi model run blocked on credentials
Date: 2026-07-18
Owner: OntoIndex maintainers

## 1. Purpose

Verify the simplest useful integration: a sub-agent running the exact `kimi-k3` model can discover and call OntoIndex MCP tools, then use their results to answer a codebase question correctly.

This is a smoke test, not a benchmark. It should answer one question: **does Kimi K3 work with the OntoIndex MCP service in an agent loop?**

## 2. Test Shape

```text
test runner
  -> verify a current index for the target file
  -> run one known-working control agent
  -> start one sub-agent with model kimi-k3
  -> expose only the read-only inspect tool
  -> require one repo-scoped call and one bounded answer
  -> persist runner metadata and the raw tool transcript
  -> verify the answer came from the MCP response
```

Use a clean sub-agent context so prior conversation does not tell the model which tools to call or what answer to return.

## 3. Preconditions

- The sub-agent runner accepts `model: kimi-k3` and reports `effective_model: kimi-k3`.
- The target repository is indexed by OntoIndex and its indexed HEAD equals the target HEAD.
- `ontoindex/src/mcp/server.ts` has no staged, unstaged, or untracked changes after indexing. Record
  the wider worktree state, but unrelated dirty files do not block this bounded lookup test.
- The MCP server is started with an explicit project and repository filter:

```bash
ontoindex mcp --project /opt/demodb/_workfolder/OntoIndex --repo ontoindex
```

- The runner exposes `mcp__ontoindex.inspect` as the only callable OntoIndex tool available to the
  test agent. Generic MCP resource functions may exist, but the agent must not invoke them.
  Prompt instructions alone do not make the default public MCP surface read-only.
- Immediately before Kimi, a recorded known-working control model must successfully run the same
  prompt, tool surface, and tool call. If the control fails, classify the run as `BLOCKED` by the
  harness.
- Generic MCP resource operations alone do not satisfy any callable-tool precondition.
- Shell, grep, direct file reads, and repository edits are forbidden in the test prompt. This makes a successful answer evidence that MCP tools were actually used.

## 4. Remediated Rerun Prompt

````text
Read-only smoke test. Work in /opt/demodb/_workfolder/OntoIndex.

Call `mcp__ontoindex.inspect` exactly once with these arguments:

```json
{
  "action": "context",
  "repo": "ontoindex",
  "name": "createMCPServer",
  "include_content": false,
  "limit": 5
}
```

Return only:

- the tool name and arguments used;
- the repository identity returned by the tool;
- the returned evidence for the `createMCPServer` definition;
- one sentence identifying its source path.

Do not grade the run. Do not use MCP resources, shell, grep, direct file reads, web, or edit tools.
If `mcp__ontoindex.inspect` is unavailable, return `TOOL_SURFACE_UNAVAILABLE` without fallback.
````

## 5. Test Cases

| ID | Check | Pass condition |
|---|---|---|
| K3-00 | Harness control | A known-working control agent completes the exact allowlisted call immediately before Kimi. |
| K3-01 | Model launch | Runner reports requested and effective model as `kimi-k3`. |
| K3-02 | Tool exposure | The Kimi agent receives `mcp__ontoindex.inspect` as its only callable OntoIndex tool; no write-capable OntoIndex tool is exposed. |
| K3-03 | Repository scope | The call arguments contain `repo: "ontoindex"`, and the response identifies `/opt/demodb/_workfolder/OntoIndex`. |
| K3-04 | Tool execution | The single `inspect` call succeeds with structured output. |
| K3-05 | MCP evidence | The tool response contains `createMCPServer` and `ontoindex/src/mcp/server.ts`. |
| K3-06 | Answer grounding | The final answer repeats the symbol and path present in that same MCP response. |
| K3-07 | No fallback or writes | The transcript contains no resource, shell, grep, direct-read, web, write, or second tool call. |
| K3-08 | Clean completion | The agent returns a bounded answer without malformed arguments, unmatched calls, or looping. |

## 6. Result Record

Record one row per run:

| Field | Value |
|---|---|
| Date/time | |
| Agent ID | |
| Requested model | `kimi-k3` |
| Effective model | |
| Model self-report | |
| Control requested model | |
| Control effective model | |
| Target HEAD | |
| Indexed HEAD | |
| Target file clean | yes / no |
| Wider worktree state | clean / dirty |
| MCP target project | |
| MCP repo filter | `ontoindex` |
| Tools attempted | |
| Successful tool calls | |
| Failed tool calls | |
| Runner metadata location | |
| Raw assistant/tool transcript location | |
| Final answer verified | |
| Overall result | PASS / FAIL / BLOCKED |
| Failure category | model / MCP startup / repo scope / schema / tool selection / tool loop / answer quality |

Persist two unmodified artifacts: runner metadata containing timestamps and requested/effective
model, and the assistant/tool transcript containing tool names, arguments, responses, and final
answer. The runner assigns every gate result. The model must not grade itself. The runner's
`effective_model` is authoritative; model self-report is recorded separately and does not override
it.

Evidence record for the pilot and remediation: `KIMI_K3_ONTOINDEX_MCP_SMOKE_TEST_EVIDENCE.md`.

## 7. Acceptance Criteria

- `PASS`: `K3-00` through `K3-08` all pass.
- `BLOCKED`: an index/target-file precondition or `K3-00` harness control fails. This is not evidence
  against Kimi K3.
- `FAIL`: the harness control passes, but any Kimi gate from `K3-01` through `K3-08` fails.

## 8. Failure Triage

| Symptom | Classification | Next action |
|---|---|---|
| Runner rejects `kimi-k3` | Model availability | Confirm the active model catalog and exact model ID. |
| Only MCP resources are available | Tool exposure | Stop before the smoke test; expose callable `mcp__ontoindex.inspect`. |
| MCP points at another repository | Repository scope | Start with `--project /opt/demodb/_workfolder/OntoIndex --repo ontoindex` and keep `repo: "ontoindex"` in the call. |
| Tool arguments are invalid | Schema/tool-use compatibility | Save the raw call and inspect the `inspect` schema; do not add more tools. |
| Tool succeeds but answer is unsupported | Answer grounding | Tighten the prompt to require returned paths/symbols and verify them. |
| Agent loops or leaves tool calls unmatched | Tool-loop compatibility | Save the complete assistant/tool message sequence and test a single required tool call before multi-step chaining. |

## 9. Optional Follow-Up

Only after this smoke test passes, run the same prompt three times and compare:

- success rate;
- number of MCP calls;
- invalid-call count;
- elapsed time;
- answer correctness.

Do not start SWE-bench or build a dedicated Kimi provider adapter for this first check. One
allowlisted `inspect` call is sufficient.

## 10. Historical Pilot Run

Completed on 2026-07-18 before the current gates were defined. Preserve it as historical evidence;
do not re-grade it as a current smoke-test run.

| Gate | Pilot result |
|---|---|
| Model requested | `kimi-k3` |
| Effective model | `kimi-k3` |
| Model launch | PASS |
| MCP resource discovery | PASS: resources and templates were discovered |
| Callable MCP discovery | FAIL: no callable OntoIndex namespace was exposed to the sub-agent |
| Repository scope | FAIL: server exposed `codex` at `/opt/demodb/_workfolder/ontocode` |
| Real OntoIndex interaction | FAIL: only resource reads succeeded; no callable OntoIndex code tool was attempted |
| No fallback | PASS: no shell, grep, direct file read, web, or edit tool was used |
| Grounded mismatch diagnosis | PASS: the reported repository mismatch matched MCP runtime output |
| Source-grounded code answer | FAIL: the requested entry point and test could not be inspected through the mis-scoped MCP server |
| Clean completion | PASS |
| Overall | FAIL: model launch and resource access worked, but callable tools and correct repository scope were both absent |

Resources attempted by the Kimi K3 agent; these are evidence of resource compatibility, not callable
OntoIndex tool compatibility:

1. MCP resource discovery;
2. MCP resource-template discovery;
3. `ontoindex://repos`;
4. `ontoindex://repo/codex/context`;
5. `ontoindex://repo/OntoIndex/context`.

The final request returned the actionable scope facts:

```text
Available repo: codex -> /opt/demodb/_workfolder/ontocode
ONTOINDEX_MCP_REPO=<unset>
ONTOINDEX_MCP_PROJECT_CWD=<unset>
process.cwd=/opt/demodb/_workfolder/ontocode
```

Required rerun setup:

```bash
cd /opt/demodb/_workfolder/OntoIndex
ontoindex analyze
ontoindex setup
```

`ontoindex setup` writes the project path but does not add an exclusive repository filter. For this
test, create or amend the dedicated MCP entry so its command contains both:

```text
mcp --project /opt/demodb/_workfolder/OntoIndex --repo ontoindex
```

Before rerunning the pilot, perform a capability probe that requires the callable `mcp__ontoindex`
namespace. Do not run or grade the smoke prompt when only generic MCP resources are available.

## 11. Remediation Results

Completed on 2026-07-18:

1. Corrected the test contract so MCP resource reads no longer count as callable OntoIndex tool use.
2. Corrected the original grading: the scope diagnosis was grounded and passes that narrow gate,
   while the source-grounded code-answer gate remains failed.
3. Added separate fields for runner-reported effective model and model self-report.
4. Indexed this checkout successfully:

```text
Repository: /opt/demodb/_workfolder/OntoIndex
Repository label: ontoindex
36,004 nodes
54,948 edges
1,316 clusters
300 flows
```

5. Ran `ontoindex setup`. Codex, Ontocode, Claude Code, Cursor, and OpenCode configurations were
   repaired to target the project, but they do not yet include the test-only `--repo ontoindex`
   filter:

```text
/usr/bin/node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js \
  mcp --project /opt/demodb/_workfolder/OntoIndex
```

6. Independently validated a fresh project-targeted MCP server with the MCP SDK. This preflight did
   not yet use the exclusive test-only repository filter:

| Check | Result |
|---|---|
| Target project path | `/opt/demodb/_workfolder/OntoIndex` |
| Loaded repositories | `codex`, `ontoindex` |
| Public tools listed | 61 |
| Required tools present | `gn_help`, `gn_explore`, `discover`, `search`, `inspect` |
| `gn_help` call | PASS |

7. Ran a fresh `kimi-k3` capability probe. The runner reported `effective_model: kimi-k3`, but the
   sub-agent received only generic MCP resource operations and no callable `mcp__ontoindex.*` tools.

8. Independent review found that the rerun must also use `--repo ontoindex` or explicit
   `repo: "ontoindex"` on every code call. The current rerun prompt now requires both.

9. Direct MCP contract testing found that `gn_explore` returned no symbol/path evidence for the
   proposed query. Replaced it with the deterministic `inspect` call above, which returned:

```text
repoLabel: ontoindex
repoPath: /opt/demodb/_workfolder/OntoIndex
symbol: createMCPServer
filePath: ontoindex/src/mcp/server.ts
```

Current blocker:

```text
ONTOINDEX SERVER: READY
PROJECT-PATH CLIENT CONFIGURATION: REPAIRED
TEST-ONLY --repo ontoindex CONFIGURATION: PENDING
KIMI K3 MODEL LAUNCH: READY
SUB-AGENT CALLABLE TOOL PROVISIONING: UNAVAILABLE IN CURRENT HOST SESSION
```

Required final actions:

1. Configure the test MCP entry with `--project /opt/demodb/_workfolder/OntoIndex --repo ontoindex`.
2. Fully restart the Codex/Ontocode host so it reloads that entry.
3. Run the known-working control agent with only `mcp__ontoindex.inspect` exposed.
4. Run Kimi only if the control passes.

If a restarted host still gives both agents only generic MCP resources, the runner must be changed to
propagate and allowlist the `mcp__ontoindex.inspect` callable tool. Restart is a diagnostic step,
not a guaranteed fix. Do not weaken the test to accept resource reads or a broad write-capable tool
surface.

## 12. Implementation

Implemented on 2026-07-18:

- runner: `ontoindex/scripts/kimi-k3-mcp-smoke.mjs`;
- focused tests: `ontoindex/test/unit/kimi-k3-mcp-smoke.test.ts`;
- package command: `npm run smoke:kimi-k3`;
- ignored runtime artifacts: `.ontoindex/smoke/kimi-k3/<run-id>/metadata.json` and
  `transcript.json`.

The runner does not depend on host sub-agent tool propagation. It implements the same isolated agent
loop directly:

1. verifies the registry entry, indexed HEAD, target HEAD, target-file cleanliness, and built CLI;
2. starts a dedicated MCP stdio process with `--project ... --repo ontoindex`;
3. performs the deterministic `inspect` preflight;
4. gives the control model exactly one OpenAI-compatible `inspect` function schema;
5. dispatches the returned function call to MCP `inspect`;
6. runs Kimi K3 only after the control passes;
7. grades the run from runner metadata and the same MCP response used by the final answer;
8. writes separate metadata and assistant/tool transcript artifacts.

Credentials are environment-only and are never accepted as command-line arguments:

```bash
export KIMI_CONTROL_MODEL='<known-working-model>'
export KIMI_CONTROL_BASE_URL='<openai-compatible-base-url>'
export KIMI_CONTROL_API_KEY='<control-key>'
export MOONSHOT_API_KEY='<kimi-key>'

cd /opt/demodb/_workfolder/OntoIndex/ontoindex
npm run smoke:kimi-k3
```

Optional real MCP-only preflight:

```bash
npm run smoke:kimi-k3 -- --mcp-only --run-id manual-preflight
```

Exit codes:

- `0`: `PASS`;
- `1`: Kimi-specific `FAIL` after a passing control;
- `2`: `BLOCKED` by preflight, credentials, skipped model phase, or control failure.

Implementation validation:

```text
Focused Vitest: 9 passed
TypeScript: npx tsc --noEmit passed
Node syntax: node --check passed
Diff check: passed
Real MCP preflight: passed
Exclusive repo filter: ontoindex
Returned symbol: createMCPServer
Returned file: ontoindex/src/mcp/server.ts
Live model phase: BLOCKED - KIMI_CONTROL_MODEL is required
```
