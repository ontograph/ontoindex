# Admission fix installed and measured

The configured executable now uses isolated candidate workspace-20261024f under
/home/er77/.local/opt/. Previous workspace-20261024e remains intact for rollback
by restoring its executable path in the ontoindex MCP args and reconnecting.
Configuration was parsed after replacement. Current-session reconnect remains
unproven; independent new stdio processes executed the candidate successfully.

Existing node scripts/build.js built product and shared modules, copied native
artifacts and pinned Linux extensions (exit 0, receipt 097b48). npm pack with
scripts disabled packaged that completed output once. Offline installation added
249 packages; package-owned native patch/verification scripts and CLI startup
then passed (exit 0). Installed runtime bytes matched freshly built dist.

Existing committed-navigation smoke ran with ONTOINDEX_WORKSPACE_MAX_FILES=Infinity:
14 calls, 20 passing checks, exit 0 (f7bc3c). Additional assertions verified all
four default navigation requests returned workspace_too_large with 1832 observed
files, limit 1600 and retryable false. Explicit committed navigation succeeded.
This proves the new guard in compiled installed execution, not just source tests.

A separate bounded persistent SDK client repeated one exact semantic request
with unchanged arguments per mode. One warm-up plus three measured calls per
mode; 8 calls total, exit 0 (138610). It reused the existing smoke payload parser
and package identity helper. Each response and duration was retained.

| Mode | Median ms | Min ms | Max ms |
| --- | ---: | ---: | ---: |
| Workspace refusal | 20.76 | 17.63 | 23.26 |
| Explicit committed search | 502.75 | 479.80 | 521.19 |

Evidence directory:
/home/er77/.local/opt/ontoindex-2.3.5-rc.12-workspace-20261024f/
contains pack.json, navigation-evidence/, repeat-responses.json,
repeat-summary.json and retained stderr. These are three-sample local observations,
not throughput, p95, cold-build memory, or unchanged-input digest proof. The
measurements do not justify a higher build ceiling. The installed package includes
the dirty checkout's existing changes, not only the admission patch.

Four bounded reviewers used Luna/Sol, including two Sol medium reviewers.
No further production edits were needed. One build, one package/install sequence,
one existing smoke and one bounded repeat measurement completed in foreground.
No detached jobs, cap increase, reindex, external publication or commit occurred.
The closed roadmap returned no_dispatch/no eligible task and was left unchanged.

Large-workspace cold preparation remains unresolved. Matching complete graph reuse
already exists; lowering semantic coverage would change results. Any next limit
change requires a controlled cold-build timing and peak-memory measurement with
isolated storage, followed by optimization or explicit measured admission policy.
