# MCP review follow-ups (2.2.25)

Date: 2026-10-13. Findings came from a read-only review of 2.2.24 (four reviewers plus live probes on the installed build). No reviewer lost its stream this round.

## Changes
- REST and eval string cap: `findOversizedArgument` runs at the top of `POST /api/search`, `POST /api/query` and `eval-server` `/tool/:name`, before repository lookup or database work (HTTP 400). REST bodies were allowed up to 10 MB, MCP strings 2 MB.
- Doctor: the Codex skills directory expectation needs `~/.codex/config.toml` or `hooks.json`; informational runtime warnings (untracked or dirty files not in the graph, no embeddings) move to `capabilityGaps` as `runtime-warnings`; any other warning keeps the verdict DEGRADED.
- Generations: `ontoindex clean --generations` (dry run by default). Reason it is needed: ordinary pruning only considers generations carrying `.retention-managed`, and every generation in ontocode (16, 4.8 GB), most of the others, predate that marker (introduced in 93c4548, 2.2.9). The reviewer found Oct 12 09:06 to 14:30 generations without a marker after that commit; whether an older binary or a swallowed marker failure produced them is not established.
- README: project selection precedence (explicit `--project`, then `ONTOINDEX_MCP_PROJECT_CWD`, then git root of the cwd, else the cwd), doctor verdicts, environment variables, generation cleanup.

## Client-visible changes
- New CLI flags `--generations` and `--keep`; HTTP 400 for oversize REST/eval strings; doctor setup and `runtime-warnings` rules.

## Not done
- No generation was deleted on this host. The ontocode set (3.98 GB reclaimable at keep 2) is a decision for the operator: `ontoindex clean --generations` shows the plan, `--force` deletes.
- Marker gap for newer generations (see above) not explained.
- `eval-server` responses are still not paged.
- REST API has no Host header check; the bearer token is the only guard there.
- Numeric clamping covers super tools only.
- Pid reuse can keep a dead pin alive; the sweep stays PID-only.
- Clone races (symlink swap, `.old-` restore over a deleted target) untested.
- `ONTOINDEX_MCP_REPO` still set in both ontocode configs although unread; configs not edited.
- `ONTOINDEX_LBUG_BUFFER_MB` default stays 0.

## Validation
- `tsc --noEmit` 0; `git diff --check` 0; build 0 with both extension files.
- 128 test files, 1,762 tests pass.
- Cleanup exercised on a sparse copy of the ontocode generation layout (names, meta, snapshot, empty database files): dry run listed 13 candidates and 3.98 GB; execute kept the active generation and 2 rollback candidates; keep 0 left only the active one. The real directory still has 16 generations.
- Artifacts: `/opt/d1/tmp/ontoindex-2.2.25-artifacts/`. Rollback: `rollback-installed-2.2.24.tar.gz`.
