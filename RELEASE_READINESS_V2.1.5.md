# OntoIndex Release Readiness

Reviewed: 2026-10-11
Status: **BLOCKED — VERSION, SECURITY AND NATIVE REFRESH GATES**

## Verified Candidate

Candidate: `5bf2cd87d75d23a21ac409a48d98079ca08b3534`.

- Full CI run `38125542187` passed, including Linux, macOS, Windows,
  Chromium, coverage, formatting, lint and typechecks.
- Isolated full analysis, forced rebuild and analysis using a copy of the
  original stale index passed. These results do not resolve the original
  working-checkout abort, `double free or corruption (out)`.
- The working index remains stale/untrusted at `df9c9dc`.
  OntoIndex stale/degraded: native refresh failed; source inspection is authority.

Evidence and limitations are recorded in
[the release audit](.memory-bank/audit_session-2026-10-11-release-readiness.md).
CI evidence applies only to the candidate above.

## Dependency Remediation

Compatible dependency updates remove all audited vulnerabilities from the root,
native, shared and CLI lockfiles. Vitest and coverage now require `^4.1.11`.
The web lockfile retains two low findings: KaTeX and its Mermaid parent under
GHSA-238p-pmpm-9mq7. No forced override or advisory acceptance was applied.

Focused validation passed: 29 CLI tests, 160 web tests and the production web
build. Full exact-commit CI and final package smoke remain required. These checks
do not establish GPU inference compatibility or resolve the native abort.

## Remaining Release Gates

1. Approve the version and channel. Package metadata records 2.1.5,
   Release Please records 1.9.8, and the latest observed stable GitHub
   release is `github-release/2.2.1`.
2. Remediate web advisory GHSA-238p-pmpm-9mq7 or obtain explicit maintainer
   risk acceptance; no compatible remediation has been established.
3. Establish the native abort's cause and validate an evidence-backed repair.
   Passing isolated runs alone do not clear this gate.
4. Align package metadata, Release Please baseline, installation documentation,
   changelogs and release notes with the approved version and channel.
5. Build and smoke-test the final versioned package, then validate its exact
   commit and artifact.
6. Obtain explicit merge and publication approval. Merging to master can
   automatically publish RC packages, prereleases and images.

No release version was selected, advisory risk accepted, tag created, merge
performed or release published. Historical August validation is not approval
to tag or publish the current candidate.
