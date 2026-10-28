# OntoIndex release readiness

## Current disposition — 2026-10-20

The [automatic-workspace closeout](.memory-bank/audit_session-2026-10-20-automatic-workspace-closeout.md)
records 34/34 ADW tasks and 49/49 independent-review tasks accepted, including
default activation and compiled checkout startup. The archived real-time plan
also records RT-5 and RT-28 DONE. These records supersede the old tracker-state
claims in the dated assessment below; they do not certify a release package.

Stable publication remains on hold. A clean installed-tarball smoke for the
current candidate, native-addon resolution outside the checkout, package-contained
guidance, version/source identity and an approved native Linux release path still
require release qualification. The nineteen allocation errors in the older live
harness remain attributed to that run; successful later tests do not establish
their root cause. Preserve that evidence for a separately scoped reproduction.
No version, source commit, package, tag or publication is created by this review.

## Historical package assessment — 2026-10-16

Date: 2026-10-16
Source: `458d1c7d5277f94ec47d601b1ef491bcea906e18` on `work/tracker-closure`.
Decision: hold stable publication pending the blockers below.

### Validation

Native Linux, Node 24.21.0, npm 11.19.0. Commands ran sequentially; every completed command below exited 0.

| Check | Command | Result |
| --- | --- | --- |
| Shared and CLI build | `cd ontoindex && node scripts/build.js` | PASS |
| CLI unit tests | `cd ontoindex && node node_modules/vitest/vitest.mjs run test/unit --maxWorkers=4 --reporter=json --outputFile=/tmp/ontoindex-release-unit-results.json` | 8541 passed, 67 skipped, 0 failed |
| Cross-process overlay | `cd ontoindex && node node_modules/vitest/vitest.mjs run test/integration/overlay-cross-process.test.ts --maxWorkers=1 --reporter=json --outputFile=/tmp/ontoindex-release-overlay-results.json` | 1 passed |
| Web types | `cd ontoindex-web && node node_modules/typescript/bin/tsc -b --noEmit` | PASS |
| Web unit tests | `cd ontoindex-web && node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=json --outputFile=/tmp/ontoindex-release-web-results.json` | 291 passed |
| Lint | `node node_modules/eslint/bin/eslint.js .` | 0 errors, 5008 warnings |
| Formatting | `node node_modules/prettier/bin/prettier.cjs --check .` | PASS |
| Workflow concurrency | `python3 .github/scripts/check-workflow-concurrency.py .github/workflows` | PASS |
| Native HTTP server tests | `node --test docker-server.test.mjs` | 5 passed; no container runtime |
| Package | `cd ontoindex && npm pack --ignore-scripts --json --pack-destination /opt/d1/tmp` | PASS; reused the completed build |
| Publish dry run | `cd ontoindex && npm publish /opt/d1/tmp/ontoindex-2.3.4.tgz --dry-run --ignore-scripts --tag rc` | PASS; npm warned that publication requires login |
| CLI smoke | `node ontoindex/dist/cli/index.js --version` and `node ontoindex/dist/cli/index.js watch --help` | Version 2.3.4; help succeeded |
| Whitespace | `git diff --check` | PASS before this report |

The tarball is `/opt/d1/tmp/ontoindex-2.3.4.tgz`, 28,876,315 bytes, 1992 entries, SHA-256 `6ba0420bd94822234e41a16ff7c02502f3790547f31a3f9c8324e85a12178e8b`. Archive inspection confirmed package version and CLI entrypoint, no absolute or parent-traversal entry paths, no symlinks or hardlinks, and no memory-bank or nested node_modules content. This is a local development package at the existing version, not a newly versioned release candidate.

Logs and JSON reports are under `/tmp/ontoindex-release-*`. Full coverage thresholds, the full integration suite, browser E2E, and a clean installation of the tarball were not run. The unit runner ignores unhandled errors by existing configuration; its passing result does not certify native teardown health. CLI smoke used the built checkout rather than an installed tarball.

### Publication blockers recorded for that candidate

1. The overlay path/ranking fix remains in `/opt/d1/tmp/wt_ovl`, including uncommitted changes. It is absent from this package. Integrate the reviewed changes onto the release branch and validate that combined source before claiming the feature is fixed.
2. The strengthened live harness passed all five visibility checks against the patched worktree but captured 19 buffer-pool allocation errors. Diagnose those errors and repeat operational acceptance. See [overlay review](RT_OVERLAY_REVIEW.md).
3. The authoritative real-time tracker remains blocked with RT-5 and RT-28 OPEN. Complete evidence acceptance through its manager tools.
4. Select the next version through the repository release policy, create a clean versioned source commit, and run coverage and installed-tarball smoke checks. The existing 2.3.4 version was preserved.
5. The release-candidate workflow requires a Docker job before its completion marker. Container execution conflicts with the repository's native-only policy; do not trigger that workflow as a compliant release path without resolving this policy mismatch.

No publication, version bump, tag, push, or external release was performed. Existing dirty state and other worktrees were preserved.
