# Workspace repair follow-up

Status: Accepted
Date: 2026-10-24
Authority: User requested review, consolidated fixes, and execution.

## Review and decision

The diagnostics change protects private causes, preserves bounded error fields,
and has accepted focused validation. It does not resolve the historical incident
or establish preparation latency. Prior validation exceeded its original budget;
the final challenger used Astra despite the declared Sol route. Preserve those
facts instead of rewriting receipts.

Unreadable-repair accounting currently precedes shared-build coalescing and lock
acquisition. Move its check and consumption into the existing build owner after
the locked snapshot recheck, only when a repair build will actually start.
Concurrent requests share that owner. Lock contention and adoption of a usable
generation do not spend an attempt. Preserve one repair per unchanged input and
existing cooldown, cancellation, lock release and size limits.

Cache the already sanitized lock failure diagnostics with busy-lock entries.
Keep the public error projection unchanged. Extend existing tests for repair
coalescing, contention recovery, retained repair refusal, cached diagnostic parity,
and input_refused dispatch projection.

## Alternatives and second challenge

| Issue | Alternatives | Selected and rationale |
| --- | --- | --- |
| Repair refusal | Remove guard; add separate repair state machine; move guard inside shared owner | Existing owner avoids duplicate synchronization and preserves bounded repair |
| Busy diagnostics | Cache safe fields; reconstruct errno only; disable cache | Cache safe object preserves exact parity and avoids extra lock acquisition |
| Dispatch coverage | Parameterize existing fixture; separate fixture; full new integration harness | Parameterize existing fixture with unchanged harness and public surface |
| Performance | Measure first; cache planning snapshots; raise size cap/narrow graph | Retain policy; call-count regressions prove reuse without unsupported latency claims |
| Assurance | Documentation only; fresh permitted-model validation; deployed historical reproduction | Fresh bounded validation plus corrected history; historical inputs/version remain unknown |

Second review: moving only assignment is insufficient if the outer check still
rejects concurrent callers. Check after the locked recheck so another process's
usable generation can be adopted. Retain failure behavior after a real failed
repair. Never cache raw cause/message fields as public diagnostics. No dependency,
new service, cache identity redesign, automatic fallback, or limit increase.

## Validation

Native focused runtime, dispatch, MCP error and committed-navigation tests;
TypeScript no-emit check; bounded OntoIndex diff evidence and scoped whitespace
check. Assert one build for concurrent repair and zero builds during contention.
No measured latency improvement or deployed incident resolution is claimed.
