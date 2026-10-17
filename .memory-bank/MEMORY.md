# Memory Index

Active-only project router. Keep at or below 100 lines. Closed plans live under
[`archive/`](archive/MEMORY_ARCHIVE.md) and are not normal task context.

## Authorities

- [Current project status](project_plan-current.md) - in-progress plans and next tasks.
- [Pending tasks](project_pending-tasks.md) - waiting and blocked plans.
- [Architecture](project_architecture.md) - owners and change-home rules (details in `../ARCHITECTURE.md`).
- [Guardrails](../GUARDRAILS.md) - contributor and agent rules.

## Active Plans

- [Automatic dirty-workspace answers](AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md) - ADW-1 complete. ADW-2, 2a, 2b, 2c, ADW-3, ADW-3a and ADW-3b are implemented in the working tree (127 focused tests, tsc and diff check clean) but NOT accepted by the manager loop: tracker still lists them OPEN, no PASS receipt and no independent challenger review. Overlay build uses scoped capture; reuse compares per-file content digests. Reuse now compares configuration and parser identity; FIFO ignore read and base identity are fixed. Open gaps: ancestor-symlink check-then-open window unproven; ADW-3 coalescing sits on ensureRepoInitialized (DB open), not a build owner. ADW-3a (watch callback mode, token lease, async stop, retry backoff) also implemented; ADW-3b (per-waiter bounds) implemented; ADW-4 and ADW-4a (workspace graph, capability selection) implemented with parse-error coverage tracked (partial graphs, isAuthoritativePath); ADW-5 (request-scoped generation pin) implemented; ADW-5a (thin read gate) implemented; ADW-5b and ADW-5c implemented; ADW-5d onward not started. Review round 2 fixed a stale-graph hole and unprotected overlay pruning; an opt-in route (ONTOINDEX_AUTO_WORKSPACE=1) now serves context/impact from a workspace graph for dirty trees; off by default; search, super-tools, resources, docs and pagination are not on it; performance of the reuse digest probe unmeasured.
- [Real-time dirty-worktree support](REALTIME_DIRTY_WORKTREE_SUPPORT_PROJECT_PLAN.md) - blocked; no active task. RT-28 is DONE; RT-5 remains open. [Latest live evidence](../RT_OVERLAY_REVIEW.md) records five passing visibility checks and unresolved buffer-pool errors.
