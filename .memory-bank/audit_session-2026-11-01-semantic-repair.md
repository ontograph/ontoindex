# All-tools semantic repair closeout

The user-authorized review compared three alternatives per issue and selected
consumer-side coordinate conversion, declaration-owned export and route evidence,
bounded rename scanning, conservative IPC/ABI findings and the existing MCP error
marker. The decision table and second challenge are in
`docs/plans/ONTOINDEX_246_SEMANTIC_REPAIR_PLAN.md`.

REPAIR-1 is DONE; manager closed, active task null, terminal no-dispatch. Four
GPT-6 Astra implementation helpers and an independent final source challenge
supported main-session acceptance. Helpers executed no validation commands.

Native build exit0; 804 tests in 23 files exit0; scoped ESLint exit0 with 0 errors
and 229 warnings; git diff --check exit0. Bounded OntoIndex verify_diff passed
the 35-file scope; symbol scanning was capped and dirty edits are absent from the
graph. Logs: `/tmp/ontoindex-semantic-repair-20261101-U4U2to`.

Buffer exhaustion remains reproducible under a serial external request. Isolate
internal queries and the 50,000-row boundary before changing memory or query
semantics. No measured speedup or complete live qualification is claimed.

## Local 2.4.7 delivery

Release commit `24b2edae0255f6d9233c0f7869cb7e10faa2e8d1` is pushed on
`fix/244-qualification`, PR181 targeting master. Full local release gate exit0:
15,529 unit tests and 3,033 integration tests passed, one expected failure and
304 skipped cases. Tested staged tree: `8ccb4488b9751cb7c6f99bf5a720abb7386c8b30`.
Commit hooks and clean-commit native build passed. Logs:
`/tmp/ontoindex-247-release-gate-20261101.log` and
`/tmp/ontoindex-247-clean-build-20261101.log`.

The install driver exited1 after the installer printed success. Source inspection
and an isolated shell reproduction establish that `cleanup_temp_asset` returns1
when a local asset leaves its temporary directory empty. No reinstall was needed.
The separately executed installed smoke exited0 and verified semantic repairs,
exports, native hash and clean release-commit provenance, database extensions,
and fresh MCP version/tool listing. Evidence:
`/tmp/ontoindex-247-installed-smoke-20261101.log`.

CLI and Ontocode/Codex MCP targets now select 2.4.7; resolved CLI reports2.4.7.
Already-running sessions retain their loaded binaries. Cleanup retained 2.4.4
and 2.4.6 for live processes; 2.4.5 usage is unresolved because nine same-user
process maps were unreadable. No managed copy removed; zero bytes recovered.
Disposable release staging was removed. No remote build, tag, or public release.

Installer follow-up: `scripts/install-ontoindex-latest.sh` | empty cleanup returns1
in EXIT trap | make optional cleanup successful without masking real removal
failures, with a local-asset regression | local install driver stops before smoke.
OntoIndex committed-index lookup did not contain this shell symbol; source is
authority for the diagnosis. Delivery uses one release gate, one clean build,
one install and one installed smoke; no passed suite was repeated.
