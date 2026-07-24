# Refactoring Plan: Ontocode System Warning Floods

Source report: Ontocode System Warnings Report for OntoIndex Team, 2026-07-07
Repository context in report: `/home/er77/_wrk/axel`
Reviewed source in report: `/home/er77/.ontocode/logs_2.sqlite`
Status: Slice 1 implemented; remaining slices are optional or blocked.

## Summary

The report does not show a direct OntoIndex MCP failure. It shows repeated Ontocode/backend
warnings caused primarily by unsupported-region `403` responses. The implementation work belongs in
the Ontocode source tree, not in OntoIndex MCP code, unless new MCP-specific evidence appears.

The main remaining P1 issue is auth refresh classification: the backend code
`unsupported_country_region_territory` is currently treated as `RefreshTokenFailedReason::Other`.
Analytics unsupported-region dedupe, Gemini discovery guard behavior, plugin local fallback, and
manifest prompt-length validation already exist in current source and should not be reinvented.

## Evidence Sources

OntoIndex was used for source discovery against repo label `codex`, then exact claims were verified
from source.

- Auth refresh owner: `/opt/demodb/_workfolder/ontocode/ontocode-rs/login/src/auth/manager.rs`
- Auth failure enum: `/opt/demodb/_workfolder/ontocode/ontocode-rs/protocol/src/auth.rs`
- Refresh adapter: `/opt/demodb/_workfolder/ontocode/ontocode-rs/login/src/auth/refresh_adapter.rs`
- Analytics dedupe owner: `/opt/demodb/_workfolder/ontocode/ontocode-rs/analytics/src/client.rs`
- Analytics test: `/opt/demodb/_workfolder/ontocode/ontocode-rs/analytics/src/client_tests.rs`
- Plugin list fallback owner: `/opt/demodb/_workfolder/ontocode/ontocode-rs/app-server/src/request_processors/plugins.rs`
- Remote plugin sync warning owner: `/opt/demodb/_workfolder/ontocode/ontocode-rs/core-plugins/src/manager.rs`
- Plugin manifest validation owner: `/opt/demodb/_workfolder/ontocode/ontocode-rs/core-plugins/src/manifest.rs`
- Gemini discovery guard owner: `/opt/demodb/_workfolder/ontocode/ontocode-rs/model-provider/src/models_endpoint.rs`
- Model personality warning owner: `/opt/demodb/_workfolder/ontocode/ontocode-rs/protocol/src/openai_models.rs`
- Session model-switch warning owner: `/opt/demodb/_workfolder/ontocode/ontocode-rs/core/src/session/mod.rs`

Runtime log replay is still blocked in this environment because the report paths under
`/home/er77/...` are not readable here. Treat the log counts as report evidence, not locally replayed
proof.

## Guiding Constraints

- Do not change OntoIndex MCP behavior from this report alone.
- Prefer the smallest source-owner fix over a new shared backend-state subsystem.
- Treat `unsupported_country_region_territory` as a classified terminal auth/backend condition, not
  as a generic transient network failure.
- Suppress repeated logs only after preserving one actionable diagnostic.
- Reset cached permanent failure state when the auth snapshot changes; current auth code already has
  auth-scoped permanent failure storage and clears it on refresh-relevant auth changes.
- Do not hide unrelated `403` causes such as token scope, permission, endpoint policy, or provider
  discovery configuration failures.
- Do not add a new public `RefreshTokenFailedReason` variant unless the protocol/API impact is
  intentionally accepted.

## Non-Goals

- Accepting flattened MCP tool names inside the OntoIndex MCP server.
- Refactoring OntoIndex setup, MCP schema, or index freshness handling.
- Disabling analytics globally.
- Removing plugin remote sync.
- Building a generic backend-state registry before a second terminal backend condition is proven.
- Fixing temporary synced plugin manifests instead of authoritative source manifests.

## Readiness Overview

| Slice | Status | Owner files | Allowed write set | Main decision |
| --- | --- | --- | --- | --- |
| 0. Source ownership discovery | DONE | This plan; Ontocode source refs above | Plan only | Owners identified; log replay blocked by `/home/er77` permissions |
| 1. Unsupported-region auth flood fix | DONE | `login/src/auth/manager.rs`; `login/src/auth/auth_tests.rs` | Completed in these two files; no protocol enum change | Classified unsupported-region without broad state registry |
| 2. Analytics backoff | DONE / no implementation task | `analytics/src/client.rs`; `analytics/src/client_tests.rs` | None | Existing `should_log_analytics_failure` dedupes unsupported-region 403s |
| 3. Remote plugin sync degraded mode | PARTIAL P2 | `app-server/src/request_processors/plugins.rs`; `core-plugins/src/manager.rs` | Existing plugin fetch/sync warning paths only | Local fallback exists; only warning dedupe/backoff remains optional |
| 4. Model personality warning dedupe | OPEN P3 | `protocol/src/openai_models.rs` | Existing warning path and focused tests only | Optional noise reduction unless catalog contract requires metadata fix |
| 5. Plugin manifest validation | BLOCKED | Authoritative `ngs-analysis` manifest unknown; validator in `core-plugins/src/manifest.rs` | Source plugin manifest only once found | Runtime validator exists; source manifest not found |
| 6. Gemini discovery config guard | DONE / no implementation task | `model-provider/src/models_endpoint.rs`; `models-manager/src/manager.rs` | None | Existing guard requires `env_key` API-key auth and falls back to static models |
| 7. Session model-switch diagnostic | OPEN P3 | `core/src/session/mod.rs` | Existing resume warning path and focused tests only | Optional diagnostic enrichment |

## Slice 0: Source Ownership Discovery

Owner: manager / reviewer.
Priority: P0.
Status: DONE for source ownership; runtime log replay blocked.

Evidence:
- OntoIndex discovery returned the Ontocode repo path `/opt/demodb/_workfolder/ontocode` and
  relevant analytics/auth symbols.
- Direct source inspection identified owners for auth refresh, analytics, plugin fallback, manifest
  validation, Gemini discovery, personality warning, and session model-switch warning.
- `/home/er77/.ontocode/logs_2.sqlite` and `/home/er77/_wrk/axel` were not available from this
  environment, so log replay remains an external validation step.

Closeout:
- No product code implemented.
- Implementation slices without source evidence remain blocked or optional.

## Slice 1: Unsupported-Region Auth Flood Fix

Owner: Ontocode auth refresh.
Priority: P1.
Status: DONE.

Problem:
- `request_chatgpt_token_refresh` logs failed refresh responses and calls
  `classify_refresh_token_failure`.
- `classify_refresh_token_failure` currently maps only `refresh_token_expired`,
  `refresh_token_reused`, and `refresh_token_invalidated` to specific permanent reasons.
- `unsupported_country_region_territory` falls through to `RefreshTokenFailedReason::Other`,
  triggers `Encountered unknown response while refreshing token`, and can be treated as transient
  unless the status is otherwise permanent.

Task:
- Add focused handling for backend code `unsupported_country_region_territory` at the existing auth
  refresh classification/decision point.
- Keep the first diagnostic clear and preserve the backend code/body context.
- Avoid repeated unknown-response warnings for this known backend code.
- Reuse existing auth-scoped permanent refresh failure storage when possible:
  `refresh_failure_for_auth`, `record_permanent_refresh_failure_if_unchanged`, and
  `set_cached_auth` already provide auth-scoped caching and reset on refresh-relevant auth changes.
- Prefer mapping to existing `RefreshTokenFailedReason::Other` with a specific message if that is
  enough to make the refresh failure permanent and user-actionable. Add a new protocol enum variant
  only if callers need machine-readable unsupported-region semantics.

Non-goals:
- Do not create a shared backend-state registry in this slice.
- Do not change analytics/plugin behavior as part of the auth fix.
- Do not suppress all `403` refresh failures.

Acceptance:
- Repeated refresh attempts for unchanged auth do not produce repeated ERROR/WARN floods for the same
  unsupported-region state.
- The user sees one clear unsupported-region diagnostic.
- Auth/proxy/account changes can recover because permanent failure state is scoped to the auth
  snapshot and cleared when that snapshot changes.
- Unknown backend codes still log as unknown and remain distinguishable.

Validation:
- `cargo test -p ontocode-login unsupported_region_refresh_failure_is_classified_with_specific_message --lib`
  passed.
- `cargo test -p ontocode-login unsupported_region_refresh_failure_is_permanent --lib` passed.

Closeout evidence:
- Changed `/opt/demodb/_workfolder/ontocode/ontocode-rs/login/src/auth/manager.rs`.
- Changed `/opt/demodb/_workfolder/ontocode/ontocode-rs/login/src/auth/auth_tests.rs`.
- Kept `RefreshTokenFailedReason::Other`; no protocol enum/API widening.
- Reused existing auth-scoped permanent failure behavior instead of adding a backend-state registry.
- Classified unsupported-region before generic error logging, so the known backend state avoids the
  raw `Failed to refresh token: {status}: {body}` error log.

## Slice 2: Analytics Backoff on Classified Backend Failure

Owner: Ontocode analytics client.
Priority: P1.
Status: DONE / no implementation task.

Evidence:
- `analytics/src/client.rs` defines `UNSUPPORTED_REGION_MESSAGE`.
- `send_track_events_request` calls `should_log_analytics_failure` before logging failed events.
- `should_log_analytics_failure` returns `false` after the first `403` whose body contains
  `Country, region, or territory not supported`.
- `analytics/src/client_tests.rs` includes
  `unsupported_region_analytics_failure_helper_dedupes_matching_403s`.
- Ontocode memory-bank docs also describe this accepted behavior in
  `.memory-bank/ADR_ANALYTICS_UNSUPPORTED_REGION_VISIBILITY.md` and
  `.memory-bank/UNSUPPORTED_REGION_AND_SUPPRESSION_REMOVAL_PROOF.md`.

Decision:
- Do not add a dependency from analytics to a new shared auth state unless future evidence shows the
  existing response-body dedupe is insufficient.

Validation if touched later:
- Keep the existing unsupported-region analytics helper test passing.
- Add only a focused regression test for any new warning path.

## Slice 3: Remote Plugin Sync Degraded Mode

Owner: Ontocode plugin manager and app-server plugin request processor.
Priority: P2.
Status: PARTIAL / optional warning dedupe only.

Evidence:
- Featured plugin fetch failure already returns empty featured IDs.
- Remote installed plugin fetch failure already returns local marketplaces only.
- `core-plugins/src/manager.rs` still logs remote installed plugin cache refresh failures.

Remaining task:
- If log noise remains material after Slice 1, dedupe or back off repeated remote plugin sync
  warnings by operation/status/backend code.
- Keep existing local fallback behavior unchanged.

Acceptance:
- Local plugin listing continues to work.
- Remote plugin failures remain visible once per relevant degraded state.
- No new plugin registry, scheduler, or sync path is introduced.

Validation:
- Focused plugin request/manager tests for local fallback and one-warning behavior, if the warning
  path is changed.

## Slice 4: Warning Deduplication for Model Personality Fallback

Owner: Ontocode model catalog / model instruction assembly.
Priority: P3.
Status: OPEN optional.

Problem:
- `protocol/src/openai_models.rs` logs
  `Model personality requested but model_messages is missing...` each time a personality is
  requested for a model without `model_messages`.

Task:
- Log this warning once per `(model, personality)` pair per process/session, or lower it to a
  debug-level trace if fallback is expected by contract.
- Separately verify whether `gpt-5.5` should advertise `model_messages`; if yes, fix catalog
  metadata instead of hiding the warning.

Acceptance:
- Repeated requests do not spam identical warnings.
- The first fallback remains visible.

Validation:
- Focused test or log-capture test for warning dedupe by `(model, personality)`.
- Catalog test only if `model_messages` becomes required metadata.

## Slice 5: Plugin Manifest Validation Before Runtime

Owner: Plugin packaging/sync pipeline for `ngs-analysis`.
Priority: P2.
Status: BLOCKED.

Problem:
- Runtime logs report `interface.defaultPrompt[0]` exceeds 128 characters in a temporary synced
  plugin manifest path.

Evidence:
- `core-plugins/src/manifest.rs` already enforces `MAX_DEFAULT_PROMPT_LEN = 128`, warns with the
  manifest path, and has an overlong-prompt test fixture.
- The accessible checkout does not contain the authoritative `ngs-analysis` source manifest.

Task once unblocked:
- Locate and fix the authoritative `ngs-analysis` plugin manifest, not the temporary synced copy.
- Add a pre-sync or pre-publish manifest validation check only if the packaging pipeline lacks one.

Unblock rule:
- Provide the source repository/path for the authoritative `ngs-analysis` plugin manifest.

Validation:
- Manifest validation test with overlong prompt fixture remains passing.
- Runtime smoke check shows the warning is gone for the fixed plugin.

## Slice 6: Gemini Discovery Config Guard

Owner: Ontocode model provider configuration.
Priority: P3.
Status: DONE / no implementation task.

Evidence:
- `model-provider/src/models_endpoint.rs` rejects discovery without an `env_key` API-key source with
  `"{provider_name} model discovery requires provider env_key API-key auth"`.
- `models-manager/src/manager.rs` catches discovery errors and falls back to static models.

Decision:
- Do not implement another guard. At most, consider log-level or log-once cleanup if this single
  warning becomes noisy in fresh logs.

Validation if touched later:
- Unit test discovery skip for non-`env_key` auth.
- Unit test discovery proceeds for valid `env_key` API-key auth.

## Slice 7: Session Model-Switch Diagnostic

Owner: Ontocode session resume / tool router.
Priority: P3.
Status: OPEN optional.

Problem:
- `core/src/session/mod.rs` warns when resuming a session with a different model, but the warning
  currently names only previous/current model identifiers.

Task:
- Keep the warning.
- If tool schema regeneration/reuse state is available in the same owner path, include it in the
  warning/event payload.
- Do not introduce a separate tool-router diagnostic subsystem for one informational warning.

Acceptance:
- Future logs make model-switch/tool-schema state visible without extra database digging.
- Existing resume behavior is unchanged.

Validation:
- Focused session resume test if this warning/event path already has test harness coverage.

## Cross-Slice Validation

- For Slice 1, use focused auth tests first; do not require broad Ontocode release validation for a
  classifier-only change.
- If runtime logs are available in the target environment, replay a fixture containing repeated
  unsupported-region auth failures and verify one clear diagnostic plus no repeated unknown-response
  warnings.
- If Slice 3 is later changed, verify plugin local fallback still works.
- Leave OntoIndex-specific claims out of implementation closeout unless an OntoIndex MCP failure is
  reproduced.

## Release Criteria

- Slice 1 is implemented and may ship independently as the main auth refresh flood fix.
- Slices 4 and 7 are optional noise reductions and should not block a P1 auth-flood fix.
- Slice 3 is only needed if plugin sync warnings remain noisy after Slice 1.
- Slice 5 remains blocked until the authoritative plugin manifest is found.
- Release note should be narrow: unsupported-region auth refresh failures are now classified with
  bounded logging and an actionable diagnostic.

## Open Questions

- Should unsupported-region remain `RefreshTokenFailedReason::Other` with a specific message, or is
  a new protocol enum variant worth the API impact?
- Is `gpt-5.5` required to provide `model_messages`, or is fallback expected for this model?
- Where is the authoritative `ngs-analysis` plugin source manifest?
