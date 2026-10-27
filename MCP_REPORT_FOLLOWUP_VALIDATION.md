# MCP report follow-up validation

Date: 2026-10-19
Authority: User instruction to proceed with the reviewed report

Implemented original-result evidence validation in Ontocode; additive audit
evaluation metadata and scoped target summaries; trusted target diagnostics;
optional response_budget_bytes using the existing pager; active-thread MCP
status using existing connection handshake metadata. See
ADR_MCP_EVIDENCE_INTERPRETATION_AND_BUDGETS.md for compatibility decisions.

## Validation

Eight focused native Vitest files pass 354/354, exit 0: response-pages,
response-pages-small-budget, mcp-server-error-path, super/diagnose,
calltool-dispatch, super/pre-commit-audit, target-context, response-envelope.
TypeScript tsc --noEmit --incremental false exits 0.

Managed Rust receipts under /opt/d2/.ontocode/artifacts/compiler-lane/:

- mcp-evidence-mcp-check-20261019b: MCP library check, exit 0.
- mcp-evidence-core-check-20261019a: core/app-server libraries, exit 0.
- mcp-evidence-app-tests-check-20261019a: app-server tests compile, exit 0.
- mcp-evidence-final-consumer-20261019b: evidence tests 18/18, exit 0.

Earlier test failures were corrected before these runs. Scoped OntoIndex
verify-diff reports PASS for both repositories, with empty symbol inventories;
this establishes selected file scope, not complete dirty-source semantics.

## Follow-up verification

The remaining focused checks completed on 2026-10-19:

- mcp-report-runtime-20261019e: active-connection integration test 1/1, exit 0;
  status reads preserve connection count 1.
- mcp-report-generation-20261019e: generation metadata regression and six
  runtime tests 7/7, exit 0.
- mcp-report-clippy-20261019e: scoped library Clippy exit 0; existing warnings
  remain. Final just fmt and both repositories' diff whitespace checks exit 0.
- Pre-commit audit suite 39/39 and TypeScript checking exit 0.

Source review found and corrected two gaps: symbol scan overflow now prevents
completed audit evaluation; snapshot names/auth now belong to the connection
manager generation. Three obsolete runtime test-fixture fields were removed
after they prevented compilation. The focused checks above include that repair.

No full suite, installed-server smoke, commit, publication or index refresh
was performed. Concurrent project state remains with its existing owners.
Graph verification is bounded: empty symbol inventories and neighboring source
line mappings limit its authority; direct source diffs were reviewed.
Knowledge handoff: none; existing build rules already cover terminal receipts
and preserving concurrent changes.

## Earlier validation limitations (superseded above)

The active-connection integration fixture compiles but has not executed. Low
build-filesystem space constrains linking the server/test binary; no observed
link failure is claimed. No full suite or installed-server smoke was run.
Concurrent changes, active plan state and receipts remain with their owners.
No index refresh, server replacement, commit or publication occurred.

Final lint receipt mcp-evidence-final-clippy-20261019a exits 101 because
the build filesystem filled (No space left on device). Lint is incomplete.
After harvesting it, cargo clean --profile dev -p ontocode-core removed only
regenerable development artifacts (16.6 GiB); passing receipts remain intact.
The runtime connection-count fixture remains compile-checked, not executed.
