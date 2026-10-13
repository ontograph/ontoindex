# ADR: Remove the MCP repository environment selector

Status: Accepted
Date: 2026-10-13
Authority: User instruction to remove support for `ONTOINDEX_MCP_REPO`

## Decision

OntoIndex ignores `ONTOINDEX_MCP_REPO`. MCP startup, repository resolution,
doctor, and diagnostics no longer use it to select, filter, validate, or report
a repository. Existing environment entries can remain without blocking startup.

Explicit `--repo` and tool `repo` arguments remain supported. Project selection
continues through `--project`, `ONTOINDEX_MCP_PROJECT_CWD`, and the working
directory. Explicit selector mismatch checks remain in place.

Diagnostics retain the versioned `setup.mcp.repoFilter` field as `null`.
Removed-variable values are excluded from diagnostic environment output.
Optional diagnostic `misconfiguration.mcpRepo` data is no longer emitted.

## Alternatives and challenge

- Removing only a local configuration entry fixes one host and retains the
  product behavior that caused the captured startup failure.
- A warning or rejection shim continues to inspect the removed selector and
  adds startup noise or another failure path.
- Deleting all selection and reporting uses removes the behavior across callers
  with no new runtime machinery. This is the selected option.

A second review requires preserving project-CWD fallback, nested repository
matching, explicit selector validation, and diagnostics output structure.
The shared resolver has broad callers, so compatibility regressions must cover
both valid and conflicting legacy values and unrelated working directories.

## Validation and rollback

Focused tests cover MCP startup, doctor, shared target resolution, error
formatting, diagnostics, and setup. Legacy values must not affect selection or
create mismatch warnings. Explicit selectors and project mismatch checks must
continue working. Type checking and bounded OntoIndex diff verification complete
validation. Revert only this task's source, tests, and documentation changes to
roll back; preserve concurrent changes in the checkout.
