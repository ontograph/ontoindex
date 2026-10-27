# Workspace candidate deployment

The configured MCP executable now points to
`/home/er77/.local/opt/ontoindex-2.3.5-rc.12-workspace-20261024e/node_modules/ontoindex/dist/cli/index.js`.
The previous `core-20261023c` installation remains intact. Rollback consists of
restoring that executable path in the existing ontoindex MCP args and reconnecting.
The connected conversation process has not been proven to reload; no reload tool
is exposed. New-process stdio behavior was validated independently.

Four bounded Luna/Sol reviews included two Sol medium development acceptance
reviews. No production source change was required. An isolated candidate was
selected over overwriting the active install or raising the resource ceiling.
The latter alternatives risk mixed loaded modules and unmeasured resource use.

Native foreground commands completed with exit 0:

- `node scripts/build.js` in `ontoindex`: compiled product and shared code,
  copied existing native addon and pinned Linux LadybugDB extensions.
- Direct Vitest: runtime, MCP error-path, and committed-navigation SDK suites;
  202 tests passed in three files (receipt `0c539a`).
- `npm pack --ignore-scripts`: packaged the completed build once.
- Offline npm install into the new candidate: 249 packages installed.
  npm reported unapproved lifecycle scripts; existing package patch/native
  verification scripts were then run explicitly and CLI version passed.
- Existing `committed-navigation-smoke.mjs` against the installed executable:
  14 calls, 20 passing checks, `contractPassed: true` (receipt `a0ee71`).

Smoke artifacts are in the candidate's `navigation-evidence/` directory:
manifest, responses, summary, and retained stderr. The installed runtime module
matches the freshly built dist bytes and contains failureDiagnostics and
input_refused; the old configured runtime lacked both. Configuration was parsed
after the exact executable replacement; provider settings were untouched.

The fresh committed index remains usable. Current-workspace navigation remains
unavailable because 1832 files exceed the unchanged 1600-file ceiling. The smoke
verified explicit committed provenance and size-limit remediation; it did not
inject a live build failure or benchmark larger workspaces. Source tests cover
sanitized build diagnostics, repeated failure suppression, and input invalidation.
Process-local failure suppression does not promise persistence across restarts.

One build, one test invocation, one package/install sequence, one installed MCP
smoke were executed. No detached jobs, reindex, external publication, or commit.
The previously closed authenticated roadmap was preserved. Follow-up requires
host reconnect evidence and measured preparation scope/resource work if current
workspace graph navigation above the ceiling is required.
