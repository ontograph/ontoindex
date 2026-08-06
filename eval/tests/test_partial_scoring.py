"""Tests for partial-credit and structural scoring (TASK-5, SCO-011..SCO-014)."""

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analysis.analyze_results import (  # noqa: E402
    _load_swebench_report,
    classify_outcomes,
    compute_metrics,
    run_swebench_evaluation,
    summarize_structural,
)


def _pred(patch: str = "diff --git a b"):
    return {"model_patch": patch}


def _status(f2p_ok: int, f2p_bad: int, p2p_ok: int = 1, p2p_bad: int = 0):
    """Build a SWE-bench tests_status block."""
    return {
        "FAIL_TO_PASS": {
            "success": [f"f{i}" for i in range(f2p_ok)],
            "failure": [f"F{i}" for i in range(f2p_bad)],
        },
        "PASS_TO_PASS": {
            "success": [f"p{i}" for i in range(p2p_ok)],
            "failure": [f"P{i}" for i in range(p2p_bad)],
        },
    }


# --- outcome buckets (SCO-011) ----------------------------------------------

def test_no_patch_broken_and_partial_are_distinct():
    preds = {"a": _pred(""), "b": _pred(), "c": _pred(), "d": _pred()}
    report = {
        "b": {"resolved": False, "patch_successfully_applied": True, "tests_status": _status(0, 4)},
        "c": {"resolved": False, "patch_successfully_applied": True, "tests_status": _status(3, 1)},
        "d": {"resolved": True, "patch_successfully_applied": True},
    }

    outcomes = classify_outcomes(preds, report)

    assert outcomes["no_patch"] == 1
    assert outcomes["broken_patch"] == 1
    assert outcomes["partial_pass"] == 1
    assert outcomes["resolved"] == 1


def test_unverified_is_not_counted_as_broken():
    """Absent grading is unknown, not evidence of failure."""
    outcomes = classify_outcomes({"a": _pred()}, None)

    assert outcomes["unverified"] == 1
    assert outcomes["broken_patch"] == 0


def test_unapplied_patch_is_broken():
    report = {"a": {"resolved": False, "patch_successfully_applied": False}}

    assert classify_outcomes({"a": _pred()}, report)["broken_patch"] == 1


def test_regression_is_broken_not_partial():
    """Partial credit requires no pass-to-pass regressions."""
    report = {
        "a": {
            "resolved": False,
            "patch_successfully_applied": True,
            "tests_status": _status(2, 2, p2p_ok=3, p2p_bad=1),
        }
    }

    outcomes = classify_outcomes({"a": _pred()}, report)

    assert outcomes["broken_patch"] == 1
    assert outcomes["partial_pass"] == 0


def test_fix_rate_gives_partial_credit():
    preds = {"a": _pred(), "b": _pred()}
    report = {
        "a": {"resolved": True, "patch_successfully_applied": True},
        "b": {"resolved": False, "patch_successfully_applied": True, "tests_status": _status(2, 2)},
    }

    outcomes = classify_outcomes(preds, report)

    assert outcomes["resolve_rate"] == 0.5
    assert outcomes["fix_rate"] == 0.75


def test_fix_rate_uses_actual_fail_to_pass_ratio():
    report = {
        "a": {"resolved": False, "patch_successfully_applied": True, "tests_status": _status(1, 3)}
    }

    outcomes = classify_outcomes({"a": _pred()}, report)

    assert outcomes["partial_pass"] == 1
    assert outcomes["fix_rate"] == 0.25


def test_loads_persisted_swebench_report(tmp_path):
    report_path = (
        tmp_path
        / "run"
        / "swebench_eval"
        / "logs"
        / "run_evaluation"
        / "run"
        / "model"
        / "a"
        / "report.json"
    )
    report_path.parent.mkdir(parents=True)
    report_path.write_text('{"a": {"resolved": true, "patch_successfully_applied": true}}')

    assert _load_swebench_report(tmp_path / "run") == {
        "a": {"resolved": True, "patch_successfully_applied": True}
    }


def test_swebench_command_uses_report_dir_and_loads_instance_reports(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "preds.json").write_text('{"a": {"model_patch": "patch"}}')

    def fake_run(cmd, **kwargs):
        assert "--output_dir" not in cmd
        assert "--report_dir" in cmd
        assert Path(kwargs["cwd"]) == run_dir / "swebench_eval"
        report = (
            run_dir
            / "swebench_eval"
            / "logs"
            / "run_evaluation"
            / "run"
            / "model"
            / "a"
            / "report.json"
        )
        report.parent.mkdir(parents=True)
        report.write_text('{"a": {"resolved": true, "patch_successfully_applied": true}}')

        class Result:
            returncode = 0
            stderr = ""

        return Result()

    with patch("analysis.analyze_results.subprocess.run", side_effect=fake_run):
        report = run_swebench_evaluation(tmp_path, "run")

    assert report == {"a": {"resolved": True, "patch_successfully_applied": True}}


# --- structural headline metric (SCO-012, SCO-013) --------------------------

def test_functional_pass_structural_fail_is_reported():
    summary = {
        "results": [
            {"instance_id": "a", "structural_oracles": {"overall": "FAIL"}},
            {"instance_id": "b", "structural_oracles": {"overall": "PASS"}},
        ]
    }
    report = {"a": {"resolved": True}, "b": {"resolved": True}}

    structural = summarize_structural(summary, report)

    assert structural["measured"] is True
    assert structural["functional_pass_structural_fail"] == 1
    assert structural["functional_pass_structural_fail_rate"] == 0.5


def test_no_oracles_reads_not_measured_not_perfect():
    summary = {"results": [{"instance_id": "a"}]}

    structural = summarize_structural(summary, {"a": {"resolved": True}})

    assert structural["measured"] is False
    assert structural["functional_pass_structural_fail_rate"] is None


def test_oracles_without_grading_are_not_measured():
    """Structural results alone cannot produce the headline rate."""
    summary = {"results": [{"instance_id": "a", "structural_oracles": {"overall": "FAIL"}}]}

    structural = summarize_structural(summary, None)

    assert structural["measured"] is False
    assert structural["graded"] == 1


def test_degraded_oracles_are_excluded_from_the_headline():
    """A check that could not run must not count as a structural pass."""
    summary = {
        "results": [{"instance_id": "a", "structural_oracles": {"overall": "DEGRADED"}}]
    }

    structural = summarize_structural(summary, {"a": {"resolved": True}})

    assert structural["degraded"] == 1
    assert structural["functional_pass_structural_fail"] == 0


# --- existing metrics unchanged (SCO-014) -----------------------------------

def test_existing_cost_and_tool_metrics_are_preserved():
    run_data = {
        "preds": {"a": _pred(), "b": _pred("")},
        "summary": {
            "results": [
                {
                    "instance_id": "a",
                    "cost": 1.5,
                    "n_calls": 10,
                    "ontoindex_metrics": {
                        "total_tool_calls": 4,
                        "augmentation_hits": 3,
                        "augmentation_calls": 6,
                    },
                }
            ]
        },
        "trajectories": {},
        "swebench_report": {"a": {"resolved": True, "patch_successfully_applied": True}},
    }

    metrics = compute_metrics(run_data)

    assert metrics["n_instances"] == 2
    assert metrics["n_with_patch"] == 1
    assert metrics["patch_rate"] == 0.5
    assert metrics["total_cost"] == 1.5
    assert metrics["total_api_calls"] == 10
    assert metrics["total_gn_tool_calls"] == 4
    assert metrics["augment_hit_rate"] == 0.5
    # New fields coexist with the originals.
    assert metrics["outcomes"]["resolved"] == 1
    assert metrics["cost_per_resolved"] == 1.5
    assert metrics["structural"]["measured"] is False
