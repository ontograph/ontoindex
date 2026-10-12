# MCP boundary, audit-root, and memory repairs

The four approved repairs are implemented in the existing owners on
`chore/release-readiness`, HEAD `7b1494cebd45eada49229ead92aa1920ff0776b0`.
Four development agents used `gpt-6.1-sol` and `gpt-6-luna`, with disjoint
implementation ownership and an independent source challenge.

Boundary tracing validates bounded facts, normalizes mechanism aliases, rejects
conflicts, and reports unsupported source-only tracing as unresolved. Explicit
receiver selection precedes SCM pairing. Acquired-prefix totals expose their
scope and whether they are exact. The public schema and stable snapshot agree.

Audit logic receives the repository root selected by public server and facade
dispatch, uses canonical containment, preserves empty inline-source precedence,
and reports unreadable input as partial. Other tools retain their dispatch shape.

Memory acquisition validates directory containment before enumeration, caps
directory entries, selected files, and actual read bytes, and uses bounded
nonblocking file-handle reads with regular-file checks. Exact-budget complete
files remain usable. Listing and optional docs summaries expose coverage and
unknown totals; metadata omits bodies. Onboarding reads its preferred artifact
directly and requires complete discovery for alphabetical fallback.

Validation after the final implementation changes:

- Native Vitest selection: 107 suites, 1513 tests, exit 0; maximum four workers.
- TypeScript: `npx tsc --noEmit`, exit 0.
- Input integrity: 2845 source, test, and fixture hashes unchanged during validation.
- `git diff --check`: exit 0.
- OntoIndex bounded `gn_verify_diff`: PASS for explicit expected files. Returned
  symbol lists are empty, so this establishes file-scope agreement rather than
  complete graph impact proof.

Evidence is retained in `/opt/d1/tmp/ontoindex-mcp-four-fixes-04jcl7e8/`:
`baseline.json`, `selected-tests.json`, `validation-inputs-final.json`,
`validation-result-final.json`, and `mcp-regression-final.log`. Baseline comparison
found only intended tracked files changed; other sessions' dirty state remains.

OntoIndex stale/degraded: uncommitted changes, scan-cap omissions, and method
metadata query failures; source inspection is authority. Indexed commit matches
HEAD. No reindex, release, GitHub CI, CodeQL, installation, push, or version
change was performed for this repair task. Native Rust formatting is inapplicable
because this checkout has no `ontocode-rs` workspace; scoped Prettier completed.

The challenge identified one additional issue outside these four repairs:
`gnAuditPrMarkerScan` passes absolute or joined relative paths to a raw read
without selected-repository containment. Current source confirms it in
`ontoindex/src/mcp/super/audit-session-tools.ts` and
`ontoindex/src/core/audit-lifecycle/pr-marker-scan.ts`. No reproduction of an
outside-repository read was performed. Candidate fixes are containment in the
MCP adapter, a repository-root-aware core scanner API, or disabling path input
in favor of inline source. Adapter containment reuses the existing helper with
the smallest compatibility surface; a core API change protects every caller but
requires wider validation, while disabling paths removes supported behavior.
This separate finding remains open for a bounded follow-up.

Canonical path checks retain their documented concurrent path-swap limitation.
Knowledge handoff: none; existing delegation and validation rules already cover
the lessons from dispatch compatibility, canonical aliases, and final-edit checks.
