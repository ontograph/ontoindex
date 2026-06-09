"""
Regression test for the _index_repository / _restore_cache call cycle.

_restore_cache calls _index_repository when restore fails (missing tarball or
exception).  _index_repository calls _restore_cache only when cache_path.exists()
is True.  The guard is that the exception handler in _restore_cache removes the
cache directory before re-calling _index_repository, so the second invocation
takes the fresh-analyze branch.

This test verifies the cycle terminates (does not recurse indefinitely) in both
failure paths:
  1. Tarball absent  — cache dir exists but index.tar.gz is missing.
  2. Restore exception — docker cp fails; _restore_cache cleans up then
     calls _index_repository which must run fresh analyze, not call
     _restore_cache again.
"""

import shutil
import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# Stub out minisweagent so the import does not require the real package.
# ---------------------------------------------------------------------------

def _install_minisweagent_stub():
    """
    Create minimal stub modules so ontoindex_docker.py can be imported without
    the real minisweagent package installed.
    """
    if "minisweagent" in sys.modules:
        return  # already present (real or stubbed)

    class _DockerEnvironment:
        def __init__(self, **kwargs):
            pass

        def start(self):
            return {}

        def stop(self):
            return {}

        def execute(self, cmd_dict):
            return {"output": "", "returncode": 0}

        def get_template_vars(self):
            return {}

        def serialize(self):
            return {}

    stub_pkg = types.ModuleType("minisweagent")
    stub_envs = types.ModuleType("minisweagent.environments")
    stub_docker = types.ModuleType("minisweagent.environments.docker")
    stub_docker.DockerEnvironment = _DockerEnvironment

    sys.modules["minisweagent"] = stub_pkg
    sys.modules["minisweagent.environments"] = stub_envs
    sys.modules["minisweagent.environments.docker"] = stub_docker


_install_minisweagent_stub()

# Now we can import unconditionally.
from environments.ontoindex_docker import OntoIndexDockerEnvironment  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_env(tmp_cache_dir: Path) -> OntoIndexDockerEnvironment:
    """Create an instance without triggering DockerEnvironment.__init__ side effects."""
    env = object.__new__(OntoIndexDockerEnvironment)
    env.cache_dir = tmp_cache_dir
    env.skip_embeddings = True
    env.ontoindex_timeout = 120
    env._ontoindex_ready = False
    env.index_time = 0.0
    env.eval_server_port = 4848
    return env


def _fake_execute(cmd_dict):
    """Minimal execute stub that returns sensible defaults."""
    command = cmd_dict.get("command", "")
    if "git remote" in command or "basename" in command:
        return {"output": "testrepo", "returncode": 0}
    if "git rev-parse" in command:
        return {"output": "abc1234", "returncode": 0}
    if "npx ontoindex analyze" in command:
        return {"output": "Indexed 10 files", "returncode": 0}
    if "find /root/.ontoindex" in command:
        return {"output": "/root/.ontoindex/kuzu", "returncode": 0}
    if "tar czf" in command:
        return {"output": "", "returncode": 0}
    return {"output": "", "returncode": 0}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestIndexRepositoryCycleGuard:
    """_index_repository / _restore_cache cycle must terminate in one pass."""

    def setup_method(self):
        self._tmp = Path(tempfile.mkdtemp())
        self.env = _make_env(self._tmp)
        self.env.execute = MagicMock(side_effect=_fake_execute)

    def teardown_method(self):
        shutil.rmtree(self._tmp, ignore_errors=True)

    # ------------------------------------------------------------------ #
    # Path 1: cache dir present, tarball absent                           #
    # ------------------------------------------------------------------ #
    def test_missing_tarball_restore_does_not_recurse(self):
        """
        When cache_path exists but index.tar.gz is absent, _restore_cache
        calls _index_repository once.  That second invocation must NOT call
        _restore_cache again (the cache dir is now gone or still empty).
        """
        repo_info = {"repo": "testrepo", "commit": "abc1234"}
        cache_key = OntoIndexDockerEnvironment._make_cache_key(repo_info)
        cache_path = self._tmp / cache_key
        cache_path.mkdir(parents=True)
        # Intentionally do NOT create index.tar.gz

        restore_call_count = []
        _original_restore = OntoIndexDockerEnvironment._restore_cache

        def counting_restore(self_inner, cp):
            restore_call_count.append(str(cp))
            _original_restore(self_inner, cp)

        with patch.object(OntoIndexDockerEnvironment, "_restore_cache", counting_restore), \
             patch.object(OntoIndexDockerEnvironment, "_save_cache"):
            self.env._index_repository()

        assert len(restore_call_count) == 1, (
            f"_restore_cache was called {len(restore_call_count)} time(s); "
            "expected exactly 1.  Cycle guard may be broken."
        )

    # ------------------------------------------------------------------ #
    # Path 2: tarball present, docker cp raises                           #
    # ------------------------------------------------------------------ #
    def test_restore_exception_cleans_up_and_analyzes_once(self):
        """
        When the restore raises (e.g. docker cp fails), _restore_cache cleans
        the cache dir and calls _index_repository.  That second invocation
        must find no cache and run ontoindex analyze exactly once — not recurse
        back into _restore_cache.
        """
        repo_info = {"repo": "testrepo", "commit": "abc1234"}
        cache_key = OntoIndexDockerEnvironment._make_cache_key(repo_info)
        cache_path = self._tmp / cache_key
        cache_path.mkdir(parents=True)
        (cache_path / "index.tar.gz").write_bytes(b"fake tarball")

        # container_id must be non-None to reach the docker cp code path
        self.env._container_id = "fake-container-abc"

        analyze_calls = []

        def tracking_execute(cmd_dict):
            if "npx ontoindex analyze" in cmd_dict.get("command", ""):
                analyze_calls.append(cmd_dict["command"])
            return _fake_execute(cmd_dict)

        self.env.execute = MagicMock(side_effect=tracking_execute)

        # docker cp raises so the exception handler in _restore_cache fires
        with patch("subprocess.run", side_effect=RuntimeError("docker cp failed")), \
             patch.object(OntoIndexDockerEnvironment, "_save_cache"):
            self.env._index_repository()

        assert len(analyze_calls) == 1, (
            f"ontoindex analyze ran {len(analyze_calls)} time(s); expected 1.  "
            "The cycle may have recursed more than once."
        )
