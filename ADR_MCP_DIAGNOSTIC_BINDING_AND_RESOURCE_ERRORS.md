# ADR: MCP diagnostic binding and resource errors

Status: Accepted
Date: 2026-10-13
Authority: User approval of the six MCP repairs

## Decision

Restart mismatch guidance offers two labeled choices: keep the original project
without the conflicting selector, or select the resolved repository by absolute
path. Startup mismatch protection remains enabled.

Doctor compares normalized absolute project paths exactly. Relative observed
paths have unverified binding because the observed process cwd is unknown.
Bare MCP launches are recognized, but absent or ambiguous project arguments
produce the existing `unavailable` state and a `DEGRADED` verdict. Failed process
discovery also remains degraded. Process presence does not
attest handshake or registration. Implicit doctor cwd uses the existing Git-root
helper; explicit project, environment, and repo selectors retain precedence.

The stdio startup owner passes its effective project through internal server
options and dispatch context. Diagnostics compare that trusted project with the
resolved target. The selected repository path travels separately to resolve
internal IDs without substituting the request target for service binding.
HTTP carries an explicitly unbound project (`null`), while
standalone diagnostics without internal context retain environment fallback.
The project context is never accepted from public tool arguments.

Resource reads reject with SDK `McpError`: malformed URI parameters use
`InvalidParams` (-32602), recognized URI shapes with unsupported resources use
the MCP resource-not-found code (-32002), and backend failures use
`InternalError` (-32603). Parser and dispatch owners classify failures directly;
error-message text is never used to infer categories. Backend failures emit a
generic public message to avoid exposing arbitrary backend data. Error JSON,
including protocol overhead, remains within the existing 48 KiB bound.

## Alternatives and challenge

Changing the selected project silently loses operator intent; two labeled
commands preserve both valid choices. Filesystem canonicalization adds I/O and
changes alias behavior; ancestor matching can select another repository.
Process cwd cannot prove binding when environment precedence is unknown.
Changing the shared explicit resolver to accept descendants broadens selection.
Global environment mutation changes concurrent callers. Removing mismatch
checks or substituting request repo paths hides real service mismatches.
Uniform internal errors lose request-error classification; error-content
envelopes continue reporting failed reads as successful content.

The second challenge requires conservative relative-path handling, duplicate
process ambiguity, implicit-cwd-only Git resolution, genuine mismatch coverage,
HTTP isolation, unspoofable internal context, and real SDK resource-error tests.
Missing-resource codes accept numeric SDK error codes rather than relying on an
enum member that the installed SDK does not provide.

## Validation and rollback

Focused tests cover each decision, real SDK resource reads, response bounds,
existing callers and schemas. Type checking and bounded OntoIndex verification
complete the gate. Revert only these repairs' hunks to roll back; preserve other
sessions' changes. Existing clients that consumed error text must now handle
resource-read rejection. No package, release, or installation change is included.
