# Workspace repair: source validation and configured artifact gap

Four read-only reviewers examined namespace prerequisites, workspace acceptance,
and runtime identity. No additional merge defect was demonstrated: the default
append hook retains distinct namespace-tagged bindings. TypeScript producer
metadata remains a separate prerequisite; a premature precedence hook would
add policy without the inputs needed to apply it.

Workspace diagnostics, sanitized phase/reason/errno, explicit committed fallback,
unchanged-input failure reuse and changed-input recovery already exist in source.
Alternatives reviewed twice: validate existing repair (selected), raise/remove
the file ceiling (requires resource evidence), or silently fall back to committed
results (reject because it changes source coverage).

Fresh foreground validation, exit 0:

- local-backend-repo-runtime and mcp-server-error-path: 178 tests, receipt 9d07a0.
- committed-navigation-smoke and backend-overlay: 130 tests, receipt 1ce606.
- Total: 308 passing tests in four suites. No production files changed.

Current host configuration names this executable:
/home/er77/.local/opt/ontoindex-2.3.5-rc.12-core-20261023c/node_modules/ontoindex/dist/cli/index.js
Only executable fields were read; credentials and process environments were not.
The configured package version is 2.3.5-rc.12. Its runtime module lacks the
failureDiagnostics implementation and input_refused handling present in current
source. Its server also lacks input_refused handling. Evidence: 355e48, 9d023f.
This is configured-artifact evidence, not proof of a running process's identity.

Installed runtime SHA256:
fd9e0234f8425b71eca258fd14eb903e5bc9a69d4bb7937438843abba09dc229
Current runtime source SHA256:
c5f7bf9f1eddc6641c56c873f2734f7f76f18b017b56dd55455bb4db5f1297ac
Source and compiled hashes are provenance only; their inequality is not a
semantic comparison. The feature check above used their actual text.

The configured artifact predates source repairs. Prepare and validate a fresh
native candidate before switching configuration and verifying host behavior.
The 1832-file workspace still exceeds the unchanged 1600-file resource ceiling;
installing diagnostics does not remove that ceiling. Explicit committed reads
remain available with current-source evidence excluded.

No detached jobs, builds, installation, configuration writes or reload occurred.
Two test invocations consumed; no development agents were needed because no new
production defect justified edits. The closed manager roadmap returned no eligible
task and was preserved. Runtime deployment and large-workspace performance remain
unverified.
