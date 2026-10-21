# ADR: Optional symbol expectations in diff verification

Status: Accepted
Date: 2026-10-21
Authority: User instruction to proceed with the proposed omitted-versus-empty contract.

## Decision

For `gn_verify_diff`, omitted `expectedSymbols` skips symbol-scope validation.
The response includes `expectedSymbols not provided; symbol scope was not checked.`
in `skipReasons`. Explicit `[]` expects no changed symbols. Populated expectations
continue checking changed symbols and reporting unexpected impacted symbols.
File expectations and required-test checks retain their existing behavior.

The `expected.symbols` array remains normalized for response compatibility;
`skipReasons` distinguishes omission from an explicitly empty expectation.
Actual changed and impacted symbols are retained regardless of expectations.
Worker review supplies bundle symbols explicitly and retains strict checks.

## Alternatives reviewed twice

Keeping omitted-as-empty is strict but makes a file-only check fail for an
unstated symbol expectation. Requiring the parameter rejects existing file-only
callers. Skipping omitted symbol checks preserves optional input semantics but
can be mistaken for comprehensive acceptance, so an explicit skip reason is
required. No discovery, authorization, or mutation guard is weakened.

## Validation and rollback

Cover omitted, empty, matching and mismatching expectations, required tests,
unexpected files, and MCP response serialization. Existing audit worker-review
tests must retain strict bundle enforcement. Rollback restores unconditional
symbol comparisons; no stored-data migration is needed.
