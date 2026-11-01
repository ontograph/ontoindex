# Refactor coordinates and advertised arguments

## Status

Accepted for the user-authorized all-tools semantic repair, 2026-11-01.

## Decision

Indexed startLine and endLine remain zero-based inclusive. Mutation AST checks use
that basis; existing human-facing edit lines and returned mutation ranges remain
one-based. Convert explicitly at consumers without persisted migration or guesses.

The refactor facade advertises existing new_body, new_name and dry_run properties.
Rename defaults to preview; replacement requires explicit dry_run true to preview
and retains its confirmation and environment gates for apply. No shared dry_run
default is advertised. safe_refactor retains its independent dryRun property.
Rename remains a bounded candidate preview and refuses apply.

Line-based JS/TS move and update apply now require an entire top-level declaration
with matching indexed name and rows. Partial export wrappers, nested declarations,
and same-line neighbors are refused before writes. This deliberately narrows
unsafe apply cases; previews and confirmation gates keep their existing behavior.

## Compatibility and validation

Existing argument forwarding and indexed navigation output stay unchanged. Schema
snapshot and facade tests cover snake-case forwarding, empty replacement bodies,
and unchanged camelCase safe_refactor behavior. Real parser-to-resolver mutation
tests cover zero-based ranges. Existing dirty, stale, permission and containment
tests remain required. No new endpoint, alias precedence or configuration is added.

## Alternatives and rollback

Storage migration changes navigation consumers; resolver-wide normalization changes
public coordinates; alias normalization introduces precedence ambiguity. Consumer
adaptation and advertising established arguments minimize compatibility risk.
Revert the consumer, schema, snapshot and accompanying tests together if needed.
