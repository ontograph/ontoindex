---
name: OntoIndex Pending Tasks
description: Compact projection of waiting and blocked manager-loop plans
type: backlog
date: 2026-10-10
status: active
---

# OntoIndex Pending Tasks

Projection only. Resume work through the linked plan's `manager_loop` block.

- [Automatic dirty-workspace answers](AUTOMATIC_DIRTY_WORKSPACE_PROJECT_PLAN.md): ADW-1 complete. ADW-2, 2a, 2b, 2c, ADW-3, ADW-3a and ADW-3b are implemented in the working tree (127 focused tests, tsc and diff check clean) but NOT accepted by the manager loop: tracker still lists them OPEN, no PASS receipt and no independent challenger review. Overlay build uses scoped capture; reuse compares per-file content digests. Reuse now compares configuration and parser identity; FIFO ignore read and base identity are fixed. Open gaps: ancestor-symlink check-then-open window unproven; ADW-3 coalescing sits on ensureRepoInitialized (DB open), not a build owner. ADW-3a (watch callback mode, token lease, async stop, retry backoff) also implemented; ADW-3b (per-waiter bounds) implemented; ADW-4 and ADW-4a (workspace graph, capability selection) implemented with parse-error coverage tracked (partial graphs, isAuthoritativePath); ADW-5 (request-scoped generation pin) implemented; ADW-5a (thin read gate) implemented; ADW-5b and ADW-5c implemented; ADW-5d onward not started. Review round 2 fixed a stale-graph hole and unprotected overlay pruning; an opt-in route (ONTOINDEX_AUTO_WORKSPACE=1) now serves context/impact from a workspace graph for dirty trees; off by default; search, super-tools, resources, docs and pagination are not on it; performance of the reuse digest probe unmeasured.

- [Real-time dirty-worktree support](REALTIME_DIRTY_WORKTREE_SUPPORT_PROJECT_PLAN.md): blocked; no active task. RT-28 completed through complete-local; RT-5 still requires closeout. [Latest validation](../RT_OVERLAY_REVIEW.md) passes all five live edit visibility checks, with buffer-pool errors and harness limitations still recorded. RT-5 requires verification and closeout of its read-path spike; RT-2 is recorded DONE.
