"""Tests for the structural oracle stage (TASK-3, SCO-005..SCO-010)."""

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from structural_oracles import (  # noqa: E402
    DEGRADED,
    ERR_BOUNDARY_VIOLATION,
    ERR_FROZEN_PATH_MODIFIED,
    ERR_ORACLE_PRECONDITION,
    ERR_ORACLE_UNSUPPORTED,
    FAIL,
    PASS,
    capture_frozen_baseline,
    evaluate_boundary_violations,
    evaluate_frozen_path_status,
    evaluate_oracles,
    frozen_paths_from,
)
from run_eval import process_instance  # noqa: E402


def _repo(tmp_path: Path, name: str = "app/main.cc", body: str = "int main(){}") -> Path:
    target = tmp_path / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body)
    return tmp_path


# --- frozen_paths (SCO-007) -------------------------------------------------

def test_frozen_path_unchanged_passes(tmp_path):
    repo = _repo(tmp_path)
    oracles = [{"id": "frozen", "check": "frozen_paths", "paths": ["app/main.cc"]}]
    baseline = capture_frozen_baseline(repo, frozen_paths_from(oracles))

    report = evaluate_oracles(oracles, repo_root=repo, frozen_baseline=baseline)

    assert report["overall"] == PASS
    assert report["results"][0]["code"] is None


def test_frozen_path_modified_fails_with_code(tmp_path):
    repo = _repo(tmp_path)
    oracles = [{"id": "frozen", "check": "frozen_paths", "paths": ["app/main.cc"]}]
    baseline = capture_frozen_baseline(repo, frozen_paths_from(oracles))

    (repo / "app/main.cc").write_text("int main(){return 1;}")
    report = evaluate_oracles(oracles, repo_root=repo, frozen_baseline=baseline)

    assert report["overall"] == FAIL
    assert report["results"][0]["code"] == ERR_FROZEN_PATH_MODIFIED


def test_frozen_path_without_baseline_is_degraded(tmp_path):
    """No baseline means the check never ran; that must not read as a pass."""
    repo = _repo(tmp_path)
    oracles = [{"id": "frozen", "check": "frozen_paths", "paths": ["app/main.cc"]}]

    report = evaluate_oracles(oracles, repo_root=repo, frozen_baseline={})

    assert report["overall"] == DEGRADED
    assert report["results"][0]["code"] == ERR_ORACLE_PRECONDITION


def test_environment_frozen_status_is_canonical(tmp_path):
    """When provided, container status replaces the host filesystem fallback."""
    report = evaluate_oracles(
        [{"id": "frozen", "check": "frozen_paths", "paths": ["app/main.cc"]}],
        repo_root=tmp_path,
        frozen_runner=lambda paths: {"status": "success", "modified": paths},
    )

    assert report["overall"] == FAIL
    assert report["results"][0]["code"] == ERR_FROZEN_PATH_MODIFIED


def test_environment_frozen_error_is_degraded():
    outcome = evaluate_frozen_path_status({"status": "error", "error": "container unavailable"})

    assert outcome["status"] == DEGRADED
    assert outcome["code"] == ERR_ORACLE_PRECONDITION


# --- boundary violations (SCO-005, SCO-006) ---------------------------------

def test_boundary_clean_passes():
    result = {
        "status": "success",
        "summary": {"rules_checked": 2, "rules_violated": 0, "total_violations": 0},
    }
    assert evaluate_boundary_violations(result)["status"] == PASS


def test_boundary_violation_fails_with_code():
    result = {
        "status": "success",
        "summary": {"rules_checked": 2, "rules_violated": 1, "total_violations": 9},
    }
    outcome = evaluate_boundary_violations(result)

    assert outcome["status"] == FAIL
    assert outcome["code"] == ERR_BOUNDARY_VIOLATION
    assert "9 violation(s)" in outcome["detail"]


def test_boundary_tool_error_is_degraded_not_fail():
    """A failed query says nothing about whether the architecture is sound."""
    outcome = evaluate_boundary_violations(
        {"status": "error", "error": "LadybugDB not initialized"}
    )

    assert outcome["status"] == DEGRADED
    assert outcome["code"] == ERR_ORACLE_PRECONDITION


def test_boundary_oracle_uses_injected_tool_runner(tmp_path):
    calls = []

    def runner(tool, oracle):
        calls.append(tool)
        return {
            "status": "success",
            "summary": {"rules_checked": 1, "rules_violated": 0, "total_violations": 0},
        }

    report = evaluate_oracles(
        [{"id": "layers", "tool": "boundary_violations"}],
        repo_root=tmp_path,
        tool_runner=runner,
    )

    assert calls == ["boundary_violations"]
    assert report["overall"] == PASS


def test_boundary_oracle_without_runner_is_degraded(tmp_path):
    report = evaluate_oracles([{"id": "layers", "tool": "boundary_violations"}], repo_root=tmp_path)

    assert report["overall"] == DEGRADED


# --- staging semantics (SCO-008, SCO-010) -----------------------------------

def test_unsupported_oracle_is_degraded(tmp_path):
    report = evaluate_oracles([{"id": "x", "tool": "gn_scope_guard"}], repo_root=tmp_path)

    assert report["overall"] == DEGRADED
    assert report["results"][0]["code"] == ERR_ORACLE_UNSUPPORTED


def test_failure_outranks_degraded(tmp_path):
    """A real violation must not be masked by an unrelated degraded check."""
    repo = _repo(tmp_path)
    oracles = [
        {"id": "frozen", "check": "frozen_paths", "paths": ["app/main.cc"]},
        {"id": "unknown", "tool": "nope"},
    ]
    baseline = capture_frozen_baseline(repo, ["app/main.cc"])
    (repo / "app/main.cc").write_text("changed")

    report = evaluate_oracles(oracles, repo_root=repo, frozen_baseline=baseline)

    assert report["overall"] == FAIL
    assert report["counts"][FAIL] == 1
    assert report["counts"][DEGRADED] == 1


def test_no_oracles_declared_is_not_measured(tmp_path):
    report = evaluate_oracles([], repo_root=tmp_path)

    assert report["overall"] == "NOT-MEASURED"
    assert report["results"] == []


def test_process_instance_uses_environment_artifact_owners(tmp_path):
    env = MagicMock()
    env.frozen_paths_status.return_value = {"status": "success", "modified": ["app/main.cc"]}
    env.run_structural_tool.return_value = {
        "status": "success",
        "summary": {"rules_checked": 1, "rules_violated": 0, "total_violations": 0},
    }
    env.graph_index_id = "eval-cache:abc"
    env.indexed_head = "deadbeef"
    env.refresh_graph_for_oracles.return_value = {
        "graph_index_id": "generation-2",
        "indexed_head": "deadbeef",
        "manifest_digest": "manifest-2",
        "authority_state": "authoritative",
        "authority_reason": "verified",
    }

    agent = MagicMock()
    agent.run.return_value = {"exit_status": "submitted"}
    agent.cost = 1.0
    agent.n_calls = 2
    agent.ontoindex_metrics.to_dict.return_value = {}

    instance = {
        "instance_id": "repo__1",
        "problem_statement": "change it",
        "structural_oracles": [
            {"id": "frozen", "check": "frozen_paths", "paths": ["app/main.cc"]},
            {"id": "layers", "tool": "boundary_violations", "rules_file": "rules.json"},
        ],
    }

    with (
        patch("run_eval._build_model", return_value=object()),
        patch("run_eval._build_environment", return_value=env),
        patch("run_eval._build_agent", return_value=agent),
        patch("run_eval._extract_submission", return_value="patch"),
    ):
        result = process_instance(instance, {}, tmp_path, "model", "mcp")

    assert result["structural_oracles"]["overall"] == FAIL
    assert result["structural_oracles"]["counts"] == {PASS: 1, FAIL: 1, DEGRADED: 0}
    assert result["graph_provenance"] == {
        "graph_index_id": "generation-2",
        "indexed_head": "deadbeef",
        "manifest_digest": "manifest-2",
        "authority_state": "authoritative",
        "authority_reason": "verified",
    }
    env.refresh_graph_for_oracles.assert_called_once_with()
    env.frozen_paths_status.assert_called_once_with(["app/main.cc"])
    env.run_structural_tool.assert_called_once()
