"""
Structural oracle stage for OntoIndex SWE-bench evaluation.

Functional tests answer "does it work". Structural oracles answer "was it built
through the intended abstraction, dependency direction, and ownership boundary".
A run passes only when both hold.

Oracles are declared as data on the task and evaluated by calling tools that
already exist. This module deliberately implements no structural predicates of
its own; the only native check is `frozen_paths`, which is a file hash
comparison.

An oracle whose preconditions cannot be met is reported DEGRADED, never PASS or
FAIL, so "the rule was violated" is always distinguishable from "the check could
not run".
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Callable, Iterable

PASS = "PASS"
FAIL = "FAIL"
DEGRADED = "DEGRADED"

ERR_FROZEN_PATH_MODIFIED = "ERR_FROZEN_PATH_MODIFIED"
ERR_BOUNDARY_VIOLATION = "ERR_BOUNDARY_VIOLATION"
ERR_ORACLE_UNSUPPORTED = "ERR_ORACLE_UNSUPPORTED"
ERR_ORACLE_PRECONDITION = "ERR_ORACLE_PRECONDITION"


def _digest(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def evaluate_frozen_paths(
    repo_root: Path,
    paths: Iterable[str],
    baseline: dict[str, str],
) -> dict[str, Any]:
    """
    Frozen files must be byte-identical to their recorded baseline digest.

    A path with no baseline digest is DEGRADED rather than PASS: absence of a
    baseline means the check never ran, which is not evidence the file is intact.
    """
    modified: list[str] = []
    unknown: list[str] = []

    for rel in paths:
        expected = baseline.get(rel)
        actual = _digest(repo_root / rel)
        if expected is None or actual is None:
            unknown.append(rel)
        elif expected != actual:
            modified.append(rel)

    if unknown:
        return {
            "status": DEGRADED,
            "code": ERR_ORACLE_PRECONDITION,
            "detail": f"no baseline or unreadable file for: {', '.join(sorted(unknown))}",
        }
    if modified:
        return {
            "status": FAIL,
            "code": ERR_FROZEN_PATH_MODIFIED,
            "detail": f"frozen path(s) modified: {', '.join(sorted(modified))}",
        }
    return {"status": PASS, "code": None, "detail": "all frozen paths unchanged"}


def evaluate_frozen_path_status(tool_result: Any) -> dict[str, Any]:
    """Interpret the environment's canonical git-status result."""
    if not isinstance(tool_result, dict) or tool_result.get("status") != "success":
        detail = (
            tool_result.get("error", "frozen path check did not succeed")
            if isinstance(tool_result, dict)
            else "frozen path check returned no usable result"
        )
        return {"status": DEGRADED, "code": ERR_ORACLE_PRECONDITION, "detail": str(detail)}

    modified = tool_result.get("modified") or []
    if modified:
        return {
            "status": FAIL,
            "code": ERR_FROZEN_PATH_MODIFIED,
            "detail": f"frozen path(s) modified: {', '.join(sorted(modified))}",
        }
    return {"status": PASS, "code": None, "detail": "all frozen paths unchanged"}


def evaluate_boundary_violations(tool_result: Any) -> dict[str, Any]:
    """
    Interpret a boundary_violations tool result.

    The tool's own error state is DEGRADED, not FAIL. A failed query says nothing
    about whether the architecture is sound.
    """
    if not isinstance(tool_result, dict):
        return {
            "status": DEGRADED,
            "code": ERR_ORACLE_PRECONDITION,
            "detail": "boundary tool returned no usable result",
        }
    if tool_result.get("status") != "success":
        return {
            "status": DEGRADED,
            "code": ERR_ORACLE_PRECONDITION,
            "detail": str(tool_result.get("error", "boundary tool did not succeed")),
        }

    summary = tool_result.get("summary") or {}
    total = summary.get("total_violations", 0)
    checked = summary.get("rules_checked", 0)
    violated = summary.get("rules_violated", 0)
    if total:
        return {
            "status": FAIL,
            "code": ERR_BOUNDARY_VIOLATION,
            "detail": f"{total} violation(s) across {violated} of {checked} rule(s)",
        }
    return {"status": PASS, "code": None, "detail": f"{checked} boundary rule(s) clean"}


def evaluate_oracles(
    oracles: list[dict],
    *,
    repo_root: Path,
    frozen_baseline: dict[str, str] | None = None,
    frozen_runner: Callable[[list[str]], Any] | None = None,
    tool_runner: Callable[[str, dict], Any] | None = None,
) -> dict[str, Any]:
    """
    Evaluate declared oracles and summarise the outcome.

    `overall` is PASS only when every oracle passed. A single DEGRADED result
    makes the whole stage DEGRADED unless something also failed outright, because
    an unverified claim must not be reported as a clean result.
    """
    results: list[dict[str, Any]] = []
    frozen_baseline = frozen_baseline or {}

    for oracle in oracles:
        oracle_id = oracle.get("id") or oracle.get("check") or oracle.get("tool") or "unnamed"
        check = oracle.get("check")
        tool = oracle.get("tool")

        if check == "frozen_paths":
            paths = oracle.get("paths", [])
            outcome = (
                evaluate_frozen_path_status(frozen_runner(paths))
                if frozen_runner is not None
                else evaluate_frozen_paths(repo_root, paths, frozen_baseline)
            )
        elif tool == "boundary_violations":
            if tool_runner is None:
                outcome = {
                    "status": DEGRADED,
                    "code": ERR_ORACLE_PRECONDITION,
                    "detail": "no tool runner available for boundary_violations",
                }
            else:
                outcome = evaluate_boundary_violations(tool_runner(tool, oracle))
        else:
            outcome = {
                "status": DEGRADED,
                "code": ERR_ORACLE_UNSUPPORTED,
                "detail": f"unsupported oracle: check={check!r} tool={tool!r}",
            }

        results.append({"id": oracle_id, **outcome})

    if not results:
        return {"overall": "NOT-MEASURED", "results": [], "counts": {}}

    counts = {
        PASS: sum(1 for r in results if r["status"] == PASS),
        FAIL: sum(1 for r in results if r["status"] == FAIL),
        DEGRADED: sum(1 for r in results if r["status"] == DEGRADED),
    }
    if counts[FAIL]:
        overall = FAIL
    elif counts[DEGRADED]:
        overall = DEGRADED
    else:
        overall = PASS
    return {"overall": overall, "results": results, "counts": counts}


def capture_frozen_baseline(repo_root: Path, paths: Iterable[str]) -> dict[str, str]:
    """Record digests for frozen paths before the agent runs."""
    baseline: dict[str, str] = {}
    for rel in paths:
        digest = _digest(repo_root / rel)
        if digest is not None:
            baseline[rel] = digest
    return baseline


def frozen_paths_from(oracles: list[dict]) -> list[str]:
    """Collect every frozen path declared across the oracle list."""
    collected: list[str] = []
    for oracle in oracles:
        if oracle.get("check") == "frozen_paths":
            collected.extend(oracle.get("paths", []))
    return collected
