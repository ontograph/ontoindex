# ADR: CLI committed navigation

Status: Accepted
Date: 2026-10-21
Authority: User review and execution instruction.

Expose existing committed reads through query, context and impact with
`--read-mode committed`; add impact UID selection. Default workspace behavior,
provenance and dirty exclusions remain. Unknown modes fail before backend startup.

Three approaches reviewed twice: full incremental relationships need dependency
closure, edge ownership and derived graph invalidation; partial neighborhoods
can miss new callers and need explicit coverage; committed CLI parity reuses
immutable graph ownership at low cost. Select CLI parity and durable process
regressions first. Default workspace availability remains unresolved.

Validate default compatibility, mode rejection, UID forwarding, committed
provenance, search bounds and diff expectations. Separate availability from
refusal-contract success. No silent fallback, retries, cap increases or input
omission. Rollback reverts only CLI and smoke additions; no data migration.
