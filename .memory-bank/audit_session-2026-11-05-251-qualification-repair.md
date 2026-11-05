# 2.5.1 qualification repairs (no build)

Date: 2026-11-05
Source: `../ontocode/docs/review/ONTOINDEX_2_5_1_QUALIFICATION_2026_11_05.md`.

## Fixes

- Findings 1–3: `isNameShadowed` (`type-extractors/shared.ts`) handles a
  function-hoisted `var` and the shared scope of a `switch` body.
  `inferConstructorReturnType` drops its function-wide binding set and calls
  `isNameShadowed` for each return. The four probe cases are now unit tests in
  `test/unit/ts-name-shadowing.test.ts`.
- Findings 4–5: `scheduleWorkspacePrebuild` skips `huge-repo-symbols` and
  include-path-scoped indexes, and its retry identity includes the active
  generation id.
- Finding 6: the two `/proc` lock tests run only on Linux.
- Finding 7: each uncovered path in the sample is capped at 256 characters,
  and a truncation flag is added.

## Investigated

The 11:25 background refresh on 2026-11-05 did not advance the index.
Job `0ee036cb` failed with "Source inputs changed during analysis; refusing
to publish", raised by the guard in `runFullAnalysis`. That guard is
intentional, so this is not a product bug.

## Validation

tsc exit 0; unit 13,165 passed. Integration: see the commit message. No build.

## Left as is

The prebuild's two cooldowns (one hour for an unchanged identity, the refresh
interval for a changed one) could be merged into one later. No end-to-end test
yet shows an automatic prebuild completing and later reads using it. That
needs an installed build.
