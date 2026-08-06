"""
OntoIndex Docker Environment for SWE-bench Evaluation

Extends mini-swe-agent's Docker environment to:
1. Install OntoIndex (Node.js + npm + ontoindex package)
2. Run `ontoindex analyze` on the repository
3. Start the eval-server daemon (persistent HTTP server with warm KuzuDB)
4. Install standalone tool scripts in /usr/local/bin/ (works with subprocess.run)
5. Cache indexes per (repo, base_commit) to avoid re-indexing

IMPORTANT: mini-swe-agent runs every command with subprocess.run in a fresh subshell.
This means .bashrc is NOT sourced, exported functions are NOT available, and env vars
don't persist. The tool scripts must be standalone executables in $PATH.

Architecture:
  Agent bash cmd → /usr/local/bin/ontoindex-query → curl localhost:4848/tool/query → eval-server → KuzuDB
  Fallback: → npx ontoindex query (cold start, slower)

Tool call latency: ~50-100ms via eval-server, ~5-10s via CLI fallback.
"""

import hashlib
import json
import logging
import shlex
import shutil
import time
from pathlib import Path

from constants import (
    EVAL_SERVER_HEALTH_INTERVAL_SECONDS,
    EVAL_SERVER_HEALTH_RETRIES,
    EVAL_SERVER_HEALTH_TIMEOUT_SECONDS,
)
from minisweagent.environments.docker import DockerEnvironment
from tool_registry import TOOL_SPECS, ToolScriptSpec
from utils.errors import is_debug_enabled, log_safe_exception

logger = logging.getLogger("ontoindex_docker")

DEFAULT_CACHE_DIR = Path.home() / ".ontoindex-eval-cache"
EVAL_SERVER_PORT = 4848


class OntoIndexDockerEnvironment(DockerEnvironment):
    """
    Docker environment with OntoIndex pre-installed, indexed, and eval-server running.

    Setup flow:
    1. Start Docker container (base SWE-bench image)
    2. Install Node.js + ontoindex inside the container
    3. Run `ontoindex analyze` (or restore from cache)
    4. Start `ontoindex eval-server` daemon (keeps KuzuDB warm)
    5. Install standalone tool scripts in /usr/local/bin/
    6. Agent runs with near-instant OntoIndex tool calls
    """

    def __init__(
        self,
        *,
        enable_ontoindex: bool = True,
        cache_dir: str | Path | None = None,
        skip_embeddings: bool = True,
        ontoindex_timeout: int = 120,
        eval_server_port: int = EVAL_SERVER_PORT,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.enable_ontoindex = enable_ontoindex
        self.cache_dir = Path(cache_dir) if cache_dir else DEFAULT_CACHE_DIR
        self.skip_embeddings = skip_embeddings
        self.ontoindex_timeout = ontoindex_timeout
        self.eval_server_port = eval_server_port
        self.index_time: float = 0.0
        self._ontoindex_ready = False
        self.graph_index_id: str | None = None
        self.indexed_head: str | None = None
        self.graph_manifest_digest: str | None = None
        self.graph_authority_state: str = "degraded"
        self.graph_authority_reason: str = "graph authority not verified"

    def start(self) -> dict:
        """Start the container and set up OntoIndex."""
        result = super().start()

        if self.enable_ontoindex:
            try:
                self._setup_ontoindex()
            except Exception as e:
                log_safe_exception(
                    logger,
                    "OntoIndex setup failed, continuing without it",
                    e,
                    include_debug=is_debug_enabled(),
                    level="warning",
                )
                self._ontoindex_ready = False

        return result

    def _setup_ontoindex(self):
        """Install and configure OntoIndex in the container."""
        start = time.time()

        self._ensure_nodejs()
        self._install_ontoindex()
        self._index_repository()
        self._start_eval_server()
        self._install_tools()

        self.index_time = time.time() - start
        self._ontoindex_ready = True
        logger.info(f"OntoIndex setup completed in {self.index_time:.1f}s")

    def _ensure_nodejs(self):
        """Ensure Node.js >= 18 is available in the container."""
        check = self.execute({"command": "node --version 2>/dev/null || echo 'NOT_FOUND'"})
        output = check.get("output", "").strip()

        if "NOT_FOUND" in output:
            logger.info("Installing Node.js in container...")
            install_cmds = [
                "apt-get update -qq",
                "apt-get install -y -qq curl ca-certificates",
                "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
                "apt-get install -y -qq nodejs",
            ]
            for cmd in install_cmds:
                result = self.execute({"command": cmd, "timeout": 60})
                if result.get("returncode", 1) != 0:
                    raise RuntimeError(f"Failed to install Node.js: {result.get('output', '')}")
        else:
            logger.info(f"Node.js already available: {output}")

    def _install_ontoindex(self):
        """Install the ontoindex npm package globally."""
        check = self.execute({"command": "npx ontoindex --version 2>/dev/null || echo 'NOT_FOUND'"})
        if "NOT_FOUND" in check.get("output", ""):
            logger.info("Installing ontoindex...")
            result = self.execute({
                "command": "npm install -g ontoindex",
                "timeout": 60,
            })
            if result.get("returncode", 1) != 0:
                raise RuntimeError(f"Failed to install ontoindex: {result.get('output', '')}")

    def _index_repository(self):
        """Run ontoindex analyze on the repo, using cache if available."""
        repo_info = self._get_repo_info()
        cache_key = self._make_cache_key(repo_info)
        cache_path = self.cache_dir / cache_key
        # The eval cache is keyed by repository and commit, so the cache key is a
        # stable identity for the exact graph snapshot used by this run whether
        # the index is restored or freshly analyzed.
        self.graph_index_id = f"eval-cache:{cache_key}"
        self.indexed_head = repo_info["commit"]

        if cache_path.exists():
            logger.info(f"Restoring OntoIndex index from cache: {cache_key}")
            self._restore_cache(cache_path)
            return

        logger.info("Running ontoindex analyze...")
        skip_flag = "--skip-embeddings" if self.skip_embeddings else ""
        result = self.execute({
            "command": f"cd /testbed && npx ontoindex analyze . {skip_flag} 2>&1",
            "timeout": self.ontoindex_timeout,
        })

        if result.get("returncode", 1) != 0:
            output = result.get("output", "")
            if "error" in output.lower() and "indexed" not in output.lower():
                raise RuntimeError(f"ontoindex analyze failed: {output[-500:]}")

        self._save_cache(cache_path, repo_info)

    def frozen_paths_status(self, paths: list[str]) -> dict:
        """Check frozen paths in the actual `/testbed` checkout.

        The harness host does not contain the checkout edited by the agent. Git
        status inside the container is the canonical artifact: any tracked,
        deleted, renamed, or untracked change to a frozen path is a violation.
        """
        if not paths:
            return {"status": "success", "modified": []}

        modified: list[str] = []
        errors: list[str] = []
        for rel in paths:
            quoted = shlex.quote(rel)
            tracked = self.execute({
                "command": f"cd /testbed && git ls-files --error-unmatch -- {quoted}",
                "timeout": 10,
            })
            if tracked.get("returncode", 1) != 0:
                errors.append(rel)
                continue
            result = self.execute({
                "command": f"cd /testbed && git status --porcelain=v1 --untracked-files=all -- {quoted}",
                "timeout": 10,
            })
            if result.get("returncode", 1) != 0:
                errors.append(rel)
            elif result.get("output", "").strip():
                modified.append(rel)

        if errors:
            return {
                "status": "error",
                "error": f"could not inspect frozen path(s): {', '.join(sorted(errors))}",
                "modified": modified,
            }
        return {"status": "success", "modified": modified}

    def run_structural_tool(self, tool: str, oracle: dict) -> dict:
        """Call an existing LocalBackend tool through the warm eval-server.

        Oracle metadata is removed from the payload; only tool arguments cross
        the boundary. The eval-server default formatter emits JSON for tools with
        no dedicated text formatter, including `boundary_violations`.
        """
        if not self._ontoindex_ready:
            return {"status": "error", "error": "OntoIndex environment is not ready"}
        if tool != "boundary_violations":
            return {"status": "error", "error": f"unsupported structural tool: {tool}"}

        payload = {
            key: value
            for key, value in oracle.items()
            if key not in {"id", "tool", "check", "expect"}
        }
        payload_json = shlex.quote(json.dumps(payload))
        result = self.execute({
            "command": (
                f"curl -sf -X POST http://127.0.0.1:{self.eval_server_port}/tool/{shlex.quote(tool)} "
                f"-H 'Content-Type: application/json' -d {payload_json}"
            ),
            "timeout": 30,
        })
        if result.get("returncode", 1) != 0:
            return {"status": "error", "error": result.get("output", "tool call failed").strip()}
        try:
            return json.loads(result.get("output", ""))
        except json.JSONDecodeError as exc:
            return {"status": "error", "error": f"tool returned non-JSON output: {exc}"}

    def _compute_source_manifest(self) -> dict:
        script = (
            "import { execFileSync } from 'node:child_process';"
            "import { pathToFileURL } from 'node:url';"
            "const root=execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim();"
            "const mod=await import(pathToFileURL(root + '/ontoindex/dist/core/indexing/source-manifest.js').href);"
            "const manifest=await mod.computeSourceManifest('/testbed');"
            "console.log(JSON.stringify({...manifest,manifestDigest:mod.sourceManifestDigest(manifest)}));"
        )
        result = self.execute({
            "command": f"cd /testbed && node --input-type=module -e {shlex.quote(script)}",
            "timeout": self.ontoindex_timeout,
        })
        if result.get("returncode", 1) != 0:
            raise RuntimeError(f"source manifest failed: {result.get('output', '').strip()}")
        lines = [line for line in result.get("output", "").splitlines() if line.strip()]
        return json.loads(lines[-1])

    def _read_active_meta(self) -> dict:
        result = self.execute({
            "command": "cd /testbed && cat .ontoindex/meta.json",
            "timeout": 10,
        })
        if result.get("returncode", 1) != 0:
            raise RuntimeError("active OntoIndex metadata is unavailable")
        return json.loads(result.get("output", ""))

    def _read_active_generation_id(self) -> str:
        result = self.execute({
            "command": "cd /testbed && basename \"$(readlink -f .ontoindex/current)\"",
            "timeout": 10,
        })
        generation_id = result.get("output", "").strip()
        if result.get("returncode", 1) != 0 or not generation_id:
            raise RuntimeError("ERR_GRAPH_GENERATION_MISSING: active generation pointer is unavailable")
        return generation_id

    def _stop_eval_server(self):
        self.execute({
            "command": f"curl -sf -X POST http://127.0.0.1:{self.eval_server_port}/shutdown >/dev/null 2>&1 || true",
            "timeout": 3,
        })
        for _ in range(EVAL_SERVER_HEALTH_RETRIES):
            exited = self.execute({
                "command": "test -s /tmp/ontoindex-eval-server.pid && ! kill -0 $(cat /tmp/ontoindex-eval-server.pid) 2>/dev/null",
                "timeout": EVAL_SERVER_HEALTH_TIMEOUT_SECONDS,
            })
            if exited.get("returncode", 1) == 0:
                return
            time.sleep(EVAL_SERVER_HEALTH_INTERVAL_SECONDS)
        raise RuntimeError("ERR_GRAPH_SHUTDOWN_TIMEOUT: eval-server process did not exit")

    def refresh_graph_for_oracles(self) -> dict:
        """Publish and verify a graph generation for the edited `/testbed` source."""
        try:
            manifest_before = self._compute_source_manifest()
            self._stop_eval_server()
            result = self.execute({
                "command": (
                    "cd /testbed && npx ontoindex analyze . --force "
                    "--skip-embeddings --skip-agents-md 2>&1"
                ),
                "timeout": self.ontoindex_timeout,
            })
            if result.get("returncode", 1) != 0:
                raise RuntimeError(f"ERR_GRAPH_ANALYZE_FAILED: {result.get('output', '')[-500:]}")

            manifest_after = self._compute_source_manifest()
            identity_fields = ("version", "sourceDigest", "sourceEntryCount", "scopeDigest", "pipelineProfile", "analyzerContractVersion")
            if any(manifest_before.get(key) != manifest_after.get(key) for key in identity_fields):
                raise RuntimeError("ERR_GRAPH_SOURCE_CHANGED: source manifest changed during refresh")

            meta = self._read_active_meta()
            active_manifest = meta.get("sourceManifest") or {}
            if any(active_manifest.get(key) != manifest_after.get(key) for key in identity_fields):
                raise RuntimeError("ERR_GRAPH_PUBLICATION_MISMATCH: active manifest does not match source")
            if active_manifest.get("coverage") != "complete":
                raise RuntimeError(f"ERR_GRAPH_COVERAGE: {active_manifest.get('coverage', 'unknown')}")
            capabilities = meta.get("capabilities") or {}
            if capabilities.get("impact") != "full" or capabilities.get("processes") is not True:
                raise RuntimeError("ERR_GRAPH_CAPABILITIES: full impact and process evidence unavailable")
            generation_id = meta.get("generationId")
            if not generation_id:
                raise RuntimeError("ERR_GRAPH_GENERATION_MISSING: active generation id is absent")
            active_generation_id = self._read_active_generation_id()
            if active_generation_id != generation_id:
                raise RuntimeError(
                    "ERR_GRAPH_PUBLICATION_MISMATCH: active generation pointer does not match metadata"
                )

            if not self._start_eval_server():
                raise RuntimeError("ERR_GRAPH_RESTART_FAILED: eval-server did not become healthy")
            self.graph_index_id = generation_id
            self.indexed_head = meta.get("lastCommit")
            self.graph_manifest_digest = manifest_after.get("manifestDigest")
            self.graph_authority_state = "authoritative"
            self.graph_authority_reason = "post-edit source manifest matches active graph generation"
        except Exception as exc:
            self.graph_authority_state = "degraded"
            self.graph_authority_reason = str(exc)
            try:
                if not self._start_eval_server():
                    self.graph_authority_reason += "; ERR_GRAPH_RESTART_FAILED: eval-server did not become healthy"
            except Exception as restart_exc:
                self.graph_authority_reason += f"; ERR_GRAPH_RESTART_FAILED: {restart_exc}"
            return self.graph_provenance()
        return self.graph_provenance()

    def graph_provenance(self) -> dict:
        return {
            "graph_index_id": self.graph_index_id,
            "indexed_head": self.indexed_head,
            "manifest_digest": self.graph_manifest_digest,
            "authority_state": self.graph_authority_state,
            "authority_reason": self.graph_authority_reason,
        }

    def _start_eval_server(self):
        """Start the OntoIndex eval-server daemon in the background."""
        logger.info(f"Starting eval-server on port {self.eval_server_port}...")

        self.execute({
            "command": (
                f"nohup npx ontoindex eval-server --port {self.eval_server_port} "
                f"--idle-timeout 600 "
                f"> /tmp/ontoindex-eval-server.log 2>&1 & echo $! > /tmp/ontoindex-eval-server.pid"
            ),
            "timeout": 5,
        })

        # Wait for the server to be ready (up to ~15s for KuzuDB init)
        for i in range(EVAL_SERVER_HEALTH_RETRIES):
            time.sleep(EVAL_SERVER_HEALTH_INTERVAL_SECONDS)
            health = self.execute({
                "command": f"curl -sf http://127.0.0.1:{self.eval_server_port}/health 2>/dev/null || echo 'NOT_READY'",
                "timeout": EVAL_SERVER_HEALTH_TIMEOUT_SECONDS,
            })
            output = health.get("output", "").strip()
            if "NOT_READY" not in output and "ok" in output:
                logger.info(
                    f"Eval-server ready after {(i + 1) * EVAL_SERVER_HEALTH_INTERVAL_SECONDS:.1f}s"
                )
                return True

        log_output = self.execute({
            "command": "cat /tmp/ontoindex-eval-server.log 2>/dev/null | tail -20",
        })
        logger.warning(
            f"Eval-server didn't become ready in "
            f"{EVAL_SERVER_HEALTH_RETRIES * EVAL_SERVER_HEALTH_INTERVAL_SECONDS:.1f}s. "
            f"Tools will fall back to direct CLI.\n"
            f"Server log: {log_output.get('output', 'N/A')}"
        )
        return False

    @staticmethod
    def _render_tool_script(spec: ToolScriptSpec, port: str) -> str:
        """
        Render a standalone bash script for a OntoIndex tool.

        Scripts call the eval-server fast path when an endpoint is present,
        and fall back to the CLI otherwise.
        """
        lines = ["#!/bin/bash"]

        if spec.endpoint:
            lines.append(f'PORT="${{ONTOINDEX_EVAL_PORT:-{port}}}"')

        if spec.header:
            lines.append(spec.header.strip())

        if spec.payload_builder:
            lines.append(spec.payload_builder.strip())

        if spec.endpoint:
            lines.append(
                f'result=$(curl -sf -X POST "http://127.0.0.1:${{PORT}}{spec.endpoint}" '
                '-H "Content-Type: application/json" -d "$payload" 2>/dev/null)'
            )
            lines.append('if [ $? -eq 0 ] && [ -n "$result" ]; then echo "$result"; exit 0; fi')

        lines.append(spec.fallback.strip())
        return "\n".join(lines)

    def _install_tools(self):
        """
        Install standalone OntoIndex tool scripts in /usr/local/bin/.

        Each script is a self-contained bash script that:
        1. Calls the eval-server via curl (fast path, ~100ms)
        2. Falls back to direct CLI if eval-server is unavailable

        These are standalone executables — no sourcing, env inheritance, or .bashrc
        needed. This is critical because mini-swe-agent runs every command via
        subprocess.run in a fresh subshell.

        Uses heredocs with quoted delimiter to avoid all quoting/escaping issues.
        """
        port = str(self.eval_server_port)

        for spec in TOOL_SPECS.values():
            script_content = self._render_tool_script(spec, port).strip()
            # Use heredoc with quoted delimiter — prevents all variable expansion and quoting issues
            self.execute({
                "command": (
                    f"cat << 'ONTOINDEX_SCRIPT_EOF' > /usr/local/bin/{spec.bin_name}\n"
                    f"{script_content}\n"
                    "ONTOINDEX_SCRIPT_EOF\n"
                    f"chmod +x /usr/local/bin/{spec.bin_name}"
                ),
                "timeout": 5,
            })

        logger.info(f"Installed {len(TOOL_SPECS)} OntoIndex tool scripts in /usr/local/bin/")

    def _get_repo_info(self) -> dict:
        """Get repository identity info from the container."""
        repo_result = self.execute({
            "command": "cd /testbed && basename $(git remote get-url origin 2>/dev/null || basename $(pwd)) .git"
        })
        commit_result = self.execute({"command": "cd /testbed && git rev-parse HEAD 2>/dev/null || echo unknown"})

        return {
            "repo": repo_result.get("output", "unknown").strip(),
            "commit": commit_result.get("output", "unknown").strip(),
        }

    @staticmethod
    def _make_cache_key(repo_info: dict) -> str:
        """Create a deterministic cache key from repo info."""
        content = f"{repo_info['repo']}:{repo_info['commit']}"
        return hashlib.sha256(content.encode()).hexdigest()[:16]

    def _save_cache(self, cache_path: Path, repo_info: dict):
        """Save the OntoIndex index to the host cache directory."""
        try:
            cache_path.mkdir(parents=True, exist_ok=True)

            find_result = self.execute({
                "command": "find /root/.ontoindex -name 'kuzu' -type d 2>/dev/null | head -1"
            })
            ontoindex_dir = find_result.get("output", "").strip()

            if ontoindex_dir:
                parent = str(Path(ontoindex_dir).parent)
                self.execute({
                    "command": f"cd {parent} && tar czf /tmp/ontoindex-cache.tar.gz .",
                    "timeout": 30,
                })

                container_id = getattr(self, "_container_id", None) or getattr(self, "container_id", None)
                if container_id:
                    import subprocess as sp
                    sp.run(
                        ["docker", "cp", f"{container_id}:/tmp/ontoindex-cache.tar.gz",
                         str(cache_path / "index.tar.gz")],
                        check=True, capture_output=True,
                    )
                    (cache_path / "metadata.json").write_text(json.dumps(repo_info, indent=2))
                    logger.info(f"Cached OntoIndex index: {cache_path}")

        except Exception as e:
            log_safe_exception(
                logger,
                "Failed to cache OntoIndex index",
                e,
                include_debug=is_debug_enabled(),
                level="warning",
            )
            if cache_path.exists():
                shutil.rmtree(cache_path, ignore_errors=True)

    def _restore_cache(self, cache_path: Path):
        """Restore a cached OntoIndex index into the container."""
        try:
            cache_tarball = cache_path / "index.tar.gz"
            if not cache_tarball.exists():
                logger.warning("Cache tarball not found, re-indexing")
                shutil.rmtree(cache_path, ignore_errors=True)
                self._index_repository()
                return

            container_id = getattr(self, "_container_id", None) or getattr(self, "container_id", None)
            if container_id:
                import subprocess as sp

                self.execute({"command": "mkdir -p /root/.ontoindex"})

                storage_result = self.execute({
                    "command": "npx ontoindex list 2>/dev/null | grep -o '/root/.ontoindex/[^ ]*' | head -1 || echo '/root/.ontoindex/repos/default'"
                })
                storage_path = storage_result.get("output", "").strip() or "/root/.ontoindex/repos/default"
                self.execute({"command": f"mkdir -p {storage_path}"})

                sp.run(
                    ["docker", "cp", str(cache_tarball), f"{container_id}:/tmp/ontoindex-cache.tar.gz"],
                    check=True, capture_output=True,
                )
                self.execute({
                    "command": f"cd {storage_path} && tar xzf /tmp/ontoindex-cache.tar.gz",
                    "timeout": 30,
                })
                logger.info("OntoIndex index restored from cache")

        except Exception as e:
            log_safe_exception(
                logger,
                "Failed to restore cache, re-indexing",
                e,
                include_debug=is_debug_enabled(),
                level="warning",
            )
            shutil.rmtree(cache_path, ignore_errors=True)
            self._index_repository()

    def stop(self) -> dict:
        """Stop the container, shutting down eval-server first."""
        if self._ontoindex_ready:
            try:
                self.execute({
                    "command": f"curl -sf -X POST http://127.0.0.1:{self.eval_server_port}/shutdown 2>/dev/null || true",
                    "timeout": 3,
                })
            except Exception:
                pass

        return super().stop()

    def get_template_vars(self) -> dict:
        """Add OntoIndex-specific template variables."""
        base_vars = super().get_template_vars()
        base_vars["ontoindex_ready"] = self._ontoindex_ready
        base_vars["ontoindex_index_time"] = self.index_time
        return base_vars

    def serialize(self) -> dict:
        """Include OntoIndex environment info in serialization."""
        base = super().serialize()
        base.setdefault("info", {})["ontoindex_env"] = {
            "enabled": self.enable_ontoindex,
            "ready": self._ontoindex_ready,
            "index_time_seconds": round(self.index_time, 2),
            "skip_embeddings": self.skip_embeddings,
            "eval_server_port": self.eval_server_port,
            "graph_index_id": self.graph_index_id,
            "indexed_head": self.indexed_head,
            "manifest_digest": self.graph_manifest_digest,
            "authority_state": self.graph_authority_state,
            "authority_reason": self.graph_authority_reason,
        }
        return base
