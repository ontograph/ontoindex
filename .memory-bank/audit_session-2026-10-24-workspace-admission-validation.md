# Workspace admission override validation

Review confirmed complete workspace graph reuse already bypasses build admission
and has regression coverage. Narrowing semantic search to symbols would remove
relationship evidence and alter ranking. Raising the default ceiling requires
new resource evidence; the default remains 1600.

The shared workspaceMaxFiles helper accepted Infinity, negative, fractional and
unsafe integer overrides. Infinity disabled both build and watcher limits.
Compared repairs: default invalid values, throw configuration errors, clamp or
round values. Two reviews selected positive-safe-integer validation with the
existing default fallback: minimal shared-owner repair, no new API, valid
operator overrides preserved. Throwing changes request failure behavior;
clamping silently reinterprets operator intent.

Two gpt-6.1-sol medium implementation agents owned disjoint production and test
files. Four initial Luna/Sol reviewers covered admission, scope, runtime identity
and performance validation. Existing unrelated dirty work was preserved.

Changed source: ontoindex/src/mcp/local/local-backend-repo-runtime.ts,
workspaceMaxFiles only. Test changes: existing watcher matrix adds Infinity;
eight invalid build-limit cases assert typed refusal before lock or build.
Focused runtime/error suites passed 187 tests, exit 0, receipt 60e02d.
TypeScript no-emit checking and scoped git diff --check passed, exit 0.
OntoIndex enclosing-flow impact was LOW; the dirty helper was not indexed.
Scoped verify_diff passed declared file comparison, without symbol-scope proof.

Host configuration points to workspace-20261024e, and a process using that
candidate was observed alongside older MCP processes. Attribution to this
session's connection remains unproven. This new parser patch is source-only;
the already-installed candidate does not include it.

The oversized-workspace limitation remains. Existing performance harness
overlay-benchmark-automatic.mjs can measure cold/warm reads and build counts;
future performance claims require fresh bounded measurements, not historical
timings. No cap increase, reindex, background job or semantic fallback occurred.
