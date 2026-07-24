# Kimi K3 - OntoIndex MCP Smoke Test Evidence

Date: 2026-07-18
Plan: `KIMI_K3_ONTOINDEX_MCP_SMOKE_TEST_PLAN.md`

This file preserves the available runner and MCP evidence. The first pilot did not capture a
machine-readable per-call trace or timings; those fields are marked unavailable rather than
reconstructed.

## Run 1: Original Pilot

| Field | Value |
|---|---|
| Agent ID | `019f7605-673f-7342-8cff-d7eaed12d2b4` |
| Date/time | 2026-07-18; exact time unavailable |
| Requested model | `kimi-k3` |
| Effective model | `kimi-k3` |
| Model self-report | Model identity unknown to the agent |
| Timing | Unavailable; not captured by the original runner invocation |
| Target HEAD | Unavailable; not captured before remediation |
| Indexed HEAD | Unavailable; the target checkout was not indexed |
| MCP target project | `/opt/demodb/_workfolder/ontocode` |
| MCP repo filter | Unset |
| Tool surface | Generic MCP resources only |
| Runner metadata artifact | Unavailable; only the runner response remained in conversation history |
| Raw assistant/tool transcript | Unavailable; only the agent's final structured summary was retained |
| Failure category | MCP repository scope and callable-tool provisioning |
| Overall | FAIL |

Resources attempted:

1. `list_mcp_resources`
2. `list_mcp_resource_templates`
3. `read_mcp_resource` for `ontoindex://repos`
4. `read_mcp_resource` for `ontoindex://repo/codex/context`
5. `read_mcp_resource` for `ontoindex://repo/OntoIndex/context`

Observed scope:

```text
Available repo: codex -> /opt/demodb/_workfolder/ontocode
ONTOINDEX_MCP_REPO=<unset>
ONTOINDEX_MCP_PROJECT_CWD=<unset>
process.cwd=/opt/demodb/_workfolder/ontocode
```

Final verdict returned by the agent:

```text
Model start: PASS
MCP resource discovery: PASS
Repository scope: FAIL
Callable OntoIndex code tool: FAIL (not exposed)
No fallback: PASS
Grounded mismatch diagnosis: PASS
Source-grounded code answer: FAIL
Clean completion: PASS
```

## Remediation

The checkout was indexed successfully:

```text
Repository label: ontoindex
Path: /opt/demodb/_workfolder/OntoIndex
Commit: 8bcdc39
36,004 nodes
54,948 edges
1,316 clusters
300 flows
```

`ontoindex setup` rewrote supported client configurations to start:

```text
/usr/bin/node /opt/demodb/_workfolder/OntoIndex/ontoindex/dist/cli/index.js \
  mcp --project /opt/demodb/_workfolder/OntoIndex
```

Verified configuration targets:

- `~/.codex/config.toml`
- `~/.ontocode/config.toml`
- `~/.claude.json`
- `~/.cursor/mcp.json`
- `~/.config/opencode/opencode.json`

## Fresh MCP Server Preflight

A standalone MCP SDK client launched the repaired command and checked the server directly.

```json
{
  "targetProjectPath": "/opt/demodb/_workfolder/OntoIndex",
  "toolCount": 61,
  "requiredToolsPresent": true,
  "sampleTools": ["gn_explore", "gn_help", "discover", "search", "inspect"],
  "gnHelpIsError": false
}
```

Server startup evidence:

```text
OntoIndex: MCP target project path: /opt/demodb/_workfolder/OntoIndex
OntoIndex: MCP server starting with 2 repo(s): codex, ontoindex
OntoIndex: exposing 61 public MCP tools (super-functions + facade API)
```

## Run 2: Post-Remediation Capability Probe

| Field | Value |
|---|---|
| Agent ID | `019f7613-cb78-7842-846f-ba2b38355e82` |
| Date/time | 2026-07-18; exact time unavailable |
| Requested model | `kimi-k3` |
| Effective model | `kimi-k3` |
| Probe identity requested | `mcp__ontoindex` |
| Reported tool-surface identity | `codex` |
| Callable OntoIndex tools available | No |
| Timing | Unavailable; capability-probe runner did not return elapsed time |
| Runner metadata artifact | Unavailable; runner result preserved below |
| Raw assistant/tool transcript | Unavailable; no callable tool was provided or invoked |
| Failure category | Sub-agent callable-tool provisioning |
| Result | STOP before smoke test |

Exact agent response:

```yaml
status: probe_complete
tool_surface_identity: codex
callable_ontoindex_available: false
reason: No callable mcp__ontoindex.* tools (gn_help, gn_explore, inspect, search, etc.) are present in my tool list; only generic MCP resource listing/reading tools are available, which do not count.
```

## Current Conclusion

The OntoIndex index, server, and public tool contract are ready. Persistent client configuration is
repaired for the project path but remains incomplete for this test until `--repo ontoindex` is added.
The current host session does not propagate callable `mcp__ontoindex.*` tools to spawned agents.
A full host restart is required before the next capability probe. If the restarted host reproduces
the same result, the remaining defect belongs to sub-agent tool-surface propagation, not OntoIndex.

## Review Addendum

Independent plan review found that the repaired client entries above contain `--project` but not
`--repo`. The fresh server preflight therefore loaded both registered repositories, exactly as the
startup evidence records. The next test must use a dedicated MCP command containing:

```text
mcp --project /opt/demodb/_workfolder/OntoIndex --repo ontoindex
```

The test call must also pass `repo: "ontoindex"` and verify the response repository identity. This
addendum does not alter the historical evidence; it corrects the next-run procedure.

The reviewed plan originally proposed `gn_explore`, but a direct MCP call returned no symbol or file
path for that query. The deterministic one-call contract is now:

```json
{
  "tool": "inspect",
  "arguments": {
    "action": "context",
    "repo": "ontoindex",
    "name": "createMCPServer",
    "include_content": false,
    "limit": 5
  },
  "expected": {
    "repoLabel": "ontoindex",
    "repoPath": "/opt/demodb/_workfolder/OntoIndex",
    "symbol": "createMCPServer",
    "filePath": "ontoindex/src/mcp/server.ts"
  }
}
```

## Implementation Evidence

Implementation files:

- `ontoindex/scripts/kimi-k3-mcp-smoke.mjs`
- `ontoindex/test/unit/kimi-k3-mcp-smoke.test.ts`
- `ontoindex/package.json` command `smoke:kimi-k3`

Validation completed on 2026-07-18:

```text
npx vitest run test/unit/kimi-k3-mcp-smoke.test.ts -> 9 passed
npx tsc --noEmit -> passed
node --check scripts/kimi-k3-mcp-smoke.mjs -> passed
git diff --check -> passed
```

Final real MCP-only run:

```text
run id: implementation-final-preflight
elapsedMs: 1210
repositoryIndexed: true
headsMatch: true
targetFileClean: true
cliExists: true
mcpPassed: true
repoLabel: ontoindex
repoPath: /opt/demodb/_workfolder/OntoIndex
symbolName: createMCPServer
filePath: ontoindex/src/mcp/server.ts
overall: BLOCKED
failureCategory: model-phase-skipped
```

Artifact:

```text
.ontoindex/smoke/kimi-k3/implementation-final-preflight/metadata.json
```

Full runner invocation without credentials:

```text
run id: implementation-final-no-credentials
repository/MCP preflight: passed
overall: BLOCKED
failureCategory: model-configuration
blockReason: KIMI_CONTROL_MODEL is required
```

Artifact:

```text
.ontoindex/smoke/kimi-k3/implementation-final-no-credentials/metadata.json
```

The live control/Kimi API phase was not executed because no model credentials were present in the
environment. Unit coverage includes a complete mocked control-plus-Kimi PASS run and a persisted
control-provider failure run.
