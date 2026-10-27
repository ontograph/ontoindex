# Workspace preparation failure diagnostics

Status: Accepted
Date: 2026-10-24
Authority: User instruction to proceed after review of workspace preparation failures

Extends ADR_WORKSPACE_PREPARATION_DIAGNOSTICS.md with build-failure fields;
the existing size projection and private-message exclusions remain in force.

## Decision

Extend the existing WorkspacePreparationError diagnostics, backend wrapper and
MCP error allowlist. Build failures retain their existing code and retryability.
Add a bounded phase (planning, lock, recheck, build, release, verification) and
reason (planning_failed, lock_failed, snapshot_failed, inputs_changed,
build_failed, timeout, cancelled, unstoppable, release_failed,
capability_missing, generation_unreadable, input_refused). Where the immediate error has an
allowlisted filesystem code, expose only EACCES, EPERM, ENOSPC, ENOENT, EMFILE,
ENFILE, EIO or EROFS as systemCode. Unknown causes stay unknown; never infer them
from message text. Typed WorkspaceBuildError.kind may refine build reasons.

Cache the same safe diagnostics with the existing 30-second failure entry.
Preserve size diagnostics, concurrency, invalidation, cooldowns and limits.
At the MCP boundary project only validated fields, rejecting unknown phases,
reasons and system codes. Never serialize causes, stderr, stacks or paths.
Provide explicit committed-mode advice for eligible build-failure navigation
requests using the existing eligibility predicate and existing fallback text.
Unsupported requests receive no committed-mode advice. No automatic mode change
or retry is introduced. Raw error detail remains private.

The reviewed concurrent input-refusal handling retains the typed `input_refused`
reason and adds fixed guidance about tracked symlinks and scan-cap exclusions to
eligible committed-mode advice. It exposes no offending path or raw error text.

## Alternatives and second review

Safe diagnostics in existing owners address the demonstrated information loss
with additive compatibility, fixed-size output, focused tests and simple rollback.
Failure-cache redesign cannot explain failures and risks suppressing transient
recovery. Narrower preparation or increased limits changes completeness and
resource use without explaining build failures. Second review preserves unknown
causes, lock-release attribution and secret suppression, and rejects parsing raw
stderr or treating a generic error as evidence of a specific root cause.

## Validation and rollback

Test planning, lock, build, verification and release failures, typed supervisor
causes, initial/cached diagnostic equality, secret suppression, malformed fields,
supported/unsupported fallback and unchanged size/cooldown behavior. Run focused
runtime, dispatch, server and committed-navigation tests plus production typecheck.
Rollback only these additive diagnostics and tests, preserving concurrent work.
