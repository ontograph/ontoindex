#!/usr/bin/env python3
"""Monitor tree-sitter 0.25 runtime and upstream ecosystem readiness.

Tracks two things Dependabot cannot see:

  1. Peer-dep compatibility. Each tree-sitter-* grammar declares a peer
     dependency on the tree-sitter runtime. We want to know when every
     grammar's *latest npm release* satisfies tree-sitter@0.25.0 so we
     can remove local vendor snapshots.

  2. Vendored upstream drift. vendor/tree-sitter-proto/ is a snapshot of
     coder3101/tree-sitter-proto's parser.c. When upstream moves, we want
     to know whether we can pick it up.

It also checks OntoIndex's actual install path. Some grammars are vendored
with patched package metadata while upstream npm releases lag behind. Those
are upstream ecosystem blockers, not runtime blockers for the shipped package.

Invoked from .github/workflows/tree-sitter-upgrade-readiness.yml daily.
Runs locally too:

    python3 .github/scripts/check-tree-sitter-upgrade-readiness.py

Outputs Markdown to stdout. Exit 0 when every grammar is upgrade-ready
and the vendored proto is in sync. Exit 1 when blockers remain (the
workflow uses this to open or update a tracking issue).

No external deps -- stdlib only, so it runs on any vanilla runner.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.request

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
ONTOINDEX_DIR = REPO_ROOT / "ontoindex"
VENDOR_PROTO_DIR = ONTOINDEX_DIR / "vendor" / "tree-sitter-proto"

# ── Upgrade target ──────────────────────────────────────────────────────
# The runtime version we want to upgrade TO. Update this when the goal
# changes (e.g. once 0.25 lands and we target 0.26).
TARGET_RUNTIME = "0.25.0"
TARGET_RUNTIME_MAJOR_MINOR = ".".join(TARGET_RUNTIME.split(".")[:2])

# Tree-sitter runtime -> (min_abi, max_abi) it can load. Only the current
# and target entries matter; extend when changing TARGET_RUNTIME.
RUNTIME_ABI_RANGES: dict[str, tuple[int, int]] = {
    "0.21": (13, 14),
    "0.25": (13, 15),
}

assert TARGET_RUNTIME_MAJOR_MINOR in RUNTIME_ABI_RANGES, (
    f"RUNTIME_ABI_RANGES has no entry for {TARGET_RUNTIME_MAJOR_MINOR!r}. "
    f"Add the ABI range after auditing the upstream release notes."
)

# Grammars we use. Values are the upstream GitHub repos to check for
# unreleased ABI bumps (owner/repo, branch, parser.c path).
GRAMMARS: dict[str, tuple[str, str, str]] = {
    "tree-sitter-c":          ("tree-sitter/tree-sitter-c",          "master", "src/parser.c"),
    "tree-sitter-c-sharp":    ("tree-sitter/tree-sitter-c-sharp",    "master", "src/parser.c"),
    "tree-sitter-cpp":        ("tree-sitter/tree-sitter-cpp",        "master", "src/parser.c"),
    "tree-sitter-dart":       ("UserNobody14/tree-sitter-dart",      "master", "src/parser.c"),
    "tree-sitter-go":         ("tree-sitter/tree-sitter-go",         "master", "src/parser.c"),
    "tree-sitter-java":       ("tree-sitter/tree-sitter-java",       "master", "src/parser.c"),
    "tree-sitter-javascript": ("tree-sitter/tree-sitter-javascript", "master", "src/parser.c"),
    "tree-sitter-kotlin":     ("fwcd/tree-sitter-kotlin",            "main",   "src/parser.c"),
    "tree-sitter-php":        ("tree-sitter/tree-sitter-php",        "master", "php/src/parser.c"),
    "tree-sitter-python":     ("tree-sitter/tree-sitter-python",     "master", "src/parser.c"),
    "tree-sitter-ruby":       ("tree-sitter/tree-sitter-ruby",       "master", "src/parser.c"),
    "tree-sitter-rust":       ("tree-sitter/tree-sitter-rust",       "master", "src/parser.c"),
    "tree-sitter-swift":      ("alex-pinkus/tree-sitter-swift",      "main",   "src/parser.c"),
    "tree-sitter-typescript": ("tree-sitter/tree-sitter-typescript", "master",  "typescript/src/parser.c"),
}

UPSTREAM_PROTO_OWNER = "coder3101"
UPSTREAM_PROTO_REPO = "tree-sitter-proto"
UPSTREAM_PROTO_BRANCH = "main"


# ── Helpers ─────────────────────────────────────────────────────────────

def read_current_runtime() -> str:
    """Return the tree-sitter runtime version pinned in package.json (e.g. '0.21')."""
    pkg = json.loads((ONTOINDEX_DIR / "package.json").read_text())
    raw = pkg["dependencies"]["tree-sitter"]
    match = re.search(r"(\d+)\.(\d+)", raw)
    if not match:
        raise SystemExit(f"could not parse tree-sitter version: {raw!r}")
    return f"{match.group(1)}.{match.group(2)}"


def read_package_json() -> dict:
    return json.loads((ONTOINDEX_DIR / "package.json").read_text())


def package_specs() -> dict[str, str]:
    pkg = read_package_json()
    return {
        **(pkg.get("dependencies") or {}),
        **(pkg.get("optionalDependencies") or {}),
    }


def vendored_package_json(pkg_name: str) -> dict | None:
    specs = package_specs()
    spec = specs.get(pkg_name)
    if not spec or not spec.startswith("file:"):
        return None
    pkg_path = (ONTOINDEX_DIR / spec.removeprefix("file:") / "package.json").resolve()
    if not pkg_path.is_file():
        return None
    return json.loads(pkg_path.read_text())


def runtime_load_smoke(grammar_names: list[str]) -> tuple[bool, list[str]]:
    """Require each grammar from the current install. Empty output means pass."""
    script = """
const grammars = JSON.parse(process.argv[1]);
const failed = [];
for (const grammar of grammars) {
  try { await import(grammar); } catch (error) { failed.push(`${grammar}: ${error.message}`); }
}
if (failed.length) {
  console.log(JSON.stringify(failed));
  process.exit(1);
}
"""
    try:
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script, json.dumps(grammar_names)],
            cwd=ONTOINDEX_DIR,
            text=True,
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, [str(exc)]
    if result.returncode == 0:
        return True, []
    try:
        return False, json.loads(result.stdout.strip() or "[]")
    except json.JSONDecodeError:
        return False, [(result.stderr or result.stdout).strip() or "unknown load failure"]


def npm_view_json(pkg: str) -> dict | None:
    """Fetch package metadata from the npm registry via HTTPS.

    Uses the registry API directly so we don't depend on the npm CLI
    being available (it's a batch file on Windows which complicates
    subprocess calls).
    """
    url = f"https://registry.npmjs.org/{pkg}/latest"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError):
        return None


def satisfies_target(peer_range: str | None, target: str) -> bool:
    """Check if a semver range like '^0.22.4' or '^0.25.0' satisfies the target.

    Simple heuristic: extract the minimum version from the range and check
    if target >= min. For caret ranges (^X.Y.Z), the upper bound is the
    next major (for X>0) or next minor (for X==0). We check both bounds.
    """
    if peer_range is None:
        # No peer dep declared = no constraint = compatible.
        return True
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", peer_range)
    if not match:
        return False
    min_major, min_minor, min_patch = int(match.group(1)), int(match.group(2)), int(match.group(3))

    t_match = re.search(r"(\d+)\.(\d+)\.(\d+)", target)
    if not t_match:
        return False
    t_major, t_minor, t_patch = int(t_match.group(1)), int(t_match.group(2)), int(t_match.group(3))

    # Target must be >= minimum.
    target_tuple = (t_major, t_minor, t_patch)
    min_tuple = (min_major, min_minor, min_patch)
    if target_tuple < min_tuple:
        return False

    # For caret ranges with major 0: ^0.X.Y allows [0.X.Y, 0.(X+1).0).
    if peer_range.startswith("^") and min_major == 0:
        if t_major != 0 or t_minor >= min_minor + 1:
            return False
    # For caret ranges with major >0: ^X.Y.Z allows [X.Y.Z, (X+1).0.0).
    elif peer_range.startswith("^") and min_major > 0:
        if t_major >= min_major + 1:
            return False

    return True


_GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")


def fetch_text(url: str, timeout: int = 8) -> str | None:
    """Fetch a URL and return its text, or None on failure.

    Adds an Authorization header for github.com URLs when GITHUB_TOKEN is
    set (raises the rate limit from 60 to 5 000 requests/hour).
    """
    headers: dict[str, str] = {}
    if _GITHUB_TOKEN and ("github.com" in url or "githubusercontent.com" in url):
        headers["Authorization"] = f"Bearer {_GITHUB_TOKEN}"
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    except (urllib.error.URLError, urllib.error.HTTPError):
        return None


def extract_abi_from_text(text: str) -> int | None:
    """Extract LANGUAGE_VERSION from parser.c text."""
    match = re.search(r"#define\s+LANGUAGE_VERSION\s+(\d+)", text[:4096])
    return int(match.group(1)) if match else None


def extract_language_version(parser_c: pathlib.Path) -> int | None:
    """Return the LANGUAGE_VERSION defined in a parser.c, or None if absent."""
    if not parser_c.is_file():
        return None
    with parser_c.open("r", encoding="utf-8", errors="ignore") as fh:
        head = fh.read(4096)
    return extract_abi_from_text(head)


def md_h(text: str, level: int = 2) -> str:
    return f"{'#' * level} {text}\n"


# ── Main ────────────────────────────────────────────────────────────────

def main() -> int:
    upstream_blockers: dict[str, str] = {}
    runtime_blockers: dict[str, str] = {}
    lines: list[str] = []
    lines.append(md_h("Tree-sitter 0.25 upgrade readiness", 1))
    lines.append("")

    current_runtime = read_current_runtime()
    current_abi_range = RUNTIME_ABI_RANGES.get(current_runtime, (0, 0))
    target_abi_range = RUNTIME_ABI_RANGES.get(TARGET_RUNTIME_MAJOR_MINOR, (0, 0))

    lines.append(f"- Current runtime: `tree-sitter@{current_runtime}.x` (ABI {current_abi_range[0]}..{current_abi_range[1]})")
    lines.append(f"- Target runtime: `tree-sitter@{TARGET_RUNTIME}` (ABI {target_abi_range[0]}..{target_abi_range[1]})")
    lines.append("- Scope: upstream npm readiness is tracked separately from OntoIndex's vendored runtime path.")
    lines.append("")

    # ── Grammar peer-dep compatibility ───────────────────────────────
    lines.append(md_h("Grammar compatibility", 2))
    lines.append("| Grammar | npm latest | Peer dep | Satisfies 0.25? | Runtime source | Runtime status | ABI | Upstream ABI | Status |")
    lines.append("|---|---|---|---|---|---|---|---|---|")

    ready_count = 0
    total_count = len(GRAMMARS)

    for name, (upstream_repo, upstream_branch, parser_path) in sorted(GRAMMARS.items()):
        # Fetch latest npm metadata.
        info = npm_view_json(name)
        fetch_failed = info is None
        npm_version = "?"
        peer_range = None
        peer_optional = True
        if info:
            npm_version = info.get("version", "?")
            peers = info.get("peerDependencies") or {}
            peer_range = peers.get("tree-sitter")
            meta = info.get("peerDependenciesMeta") or {}
            ts_meta = meta.get("tree-sitter") or {}
            peer_optional = ts_meta.get("optional", False) if peer_range else True

        if fetch_failed:
            peer_display = "? (fetch failed)"
            compatible = False
        else:
            peer_display = peer_range or "none"
            if peer_range and not peer_optional:
                peer_display += " (required)"
            compatible = satisfies_target(peer_range, TARGET_RUNTIME)

        # Check installed ABI using the same parser_path from GRAMMARS.
        installed_parser = ONTOINDEX_DIR / "node_modules" / name / parser_path
        if not installed_parser.is_file():
            # Fallback to default location.
            installed_parser = ONTOINDEX_DIR / "node_modules" / name / "src" / "parser.c"
        installed_abi = extract_language_version(installed_parser)
        abi_display = str(installed_abi) if installed_abi else "?"

        # Check upstream (main/master branch) ABI for unreleased work.
        upstream_url = (
            f"https://raw.githubusercontent.com/{upstream_repo}/"
            f"{upstream_branch}/{parser_path}"
        )
        upstream_text = fetch_text(upstream_url)
        upstream_abi = extract_abi_from_text(upstream_text) if upstream_text else None
        upstream_abi_display = str(upstream_abi) if upstream_abi else "?"

        # Determine status.
        if fetch_failed:
            status = "Unknown (fetch failed)"
            upstream_blockers[name] = f"`{name}`: npm registry fetch failed — could not verify peer dep"
        elif compatible:
            status = "Ready"
            ready_count += 1
        elif upstream_abi and upstream_abi >= 15:
            status = "Unreleased (ABI 15 on main)"
            upstream_blockers[name] = f"`{name}`: ABI 15 on `{upstream_repo}` main but not published to npm"
        else:
            status = "Blocking"
            upstream_blockers[name] = f"`{name}@{npm_version}`: peer `{peer_display}` incompatible with 0.25"

        # Also check upstream package.json for relaxed peer dep.
        if not compatible and not fetch_failed:
            upstream_pkg_url = (
                f"https://raw.githubusercontent.com/{upstream_repo}/"
                f"{upstream_branch}/package.json"
            )
            upstream_pkg_text = fetch_text(upstream_pkg_url)
            if upstream_pkg_text:
                try:
                    upstream_pkg = json.loads(upstream_pkg_text)
                    upstream_peer = (upstream_pkg.get("peerDependencies") or {}).get("tree-sitter")
                    if upstream_peer and satisfies_target(upstream_peer, TARGET_RUNTIME):
                        status = "Unreleased (peer relaxed on main)"
                        upstream_blockers[name] = f"`{name}`: peer dep relaxed on `{upstream_repo}` main but not published to npm"
                except json.JSONDecodeError:
                    pass

        vendor_pkg = vendored_package_json(name)
        if vendor_pkg:
            vendor_peer = ((vendor_pkg.get("peerDependencies") or {}).get("tree-sitter"))
            vendor_ok = satisfies_target(vendor_peer, TARGET_RUNTIME)
            runtime_source = "vendored"
            runtime_status = "Ready" if vendor_ok else f"Blocking peer `{vendor_peer or 'none'}`"
            if not vendor_ok:
                runtime_blockers[name] = f"`{name}` vendored peer `{vendor_peer}` is incompatible with `{TARGET_RUNTIME}`"
        else:
            runtime_source = "npm"
            runtime_status = "Ready" if compatible else "Tracks upstream"

        compat_icon = "Yes" if compatible else "**No**"
        lines.append(
            f"| `{name}` | {npm_version} | {peer_display} | {compat_icon} | {runtime_source} | {runtime_status} | {abi_display} | {upstream_abi_display} | {status} |"
        )

    lines.append("")
    lines.append(f"**{ready_count}/{total_count}** upstream npm grammars ready for `tree-sitter@{TARGET_RUNTIME}`.")
    lines.append("")

    # ── Runtime load smoke ───────────────────────────────────────────
    lines.append(md_h("OntoIndex runtime load smoke", 2))
    pkg = read_package_json()
    optional_grammar_names = {
        name
        for name in (pkg.get("optionalDependencies") or {})
        if name in GRAMMARS
    }
    smoke_ok, smoke_detail = runtime_load_smoke(sorted(GRAMMARS))
    if smoke_ok:
        lines.append("- All configured grammar packages load from the current OntoIndex install.")
    else:
        required_failures = [
            failure
            for failure in smoke_detail
            if failure.split(":", 1)[0] not in optional_grammar_names
        ]
        optional_failures = [
            failure
            for failure in smoke_detail
            if failure.split(":", 1)[0] in optional_grammar_names
        ]

        if required_failures:
            lines.append("- **Failed:** one or more required grammar packages did not load from the current OntoIndex install.")
            lines.append("")
            lines.append("```text")
            lines.extend(required_failures)
            lines.append("```")
            runtime_blockers["runtime-load-smoke"] = "current OntoIndex install cannot load one or more required grammar packages"
        else:
            lines.append("- Required grammar packages load from the current OntoIndex install.")

        if optional_failures:
            lines.append("- Optional grammar packages unavailable in this install:")
            lines.append("")
            lines.append("```text")
            lines.extend(optional_failures)
            lines.append("```")
    lines.append("")

    # ── Vendored proto drift ─────────────────────────────────────────
    lines.append(md_h("Vendored tree-sitter-proto", 2))
    vendored_abi = extract_language_version(VENDOR_PROTO_DIR / "src" / "parser.c")

    upstream_proto_url = (
        f"https://raw.githubusercontent.com/{UPSTREAM_PROTO_OWNER}/"
        f"{UPSTREAM_PROTO_REPO}/{UPSTREAM_PROTO_BRANCH}/src/parser.c"
    )
    upstream_proto_text = fetch_text(upstream_proto_url)
    upstream_proto_abi = extract_abi_from_text(upstream_proto_text) if upstream_proto_text else None

    sha_url = (
        f"https://api.github.com/repos/{UPSTREAM_PROTO_OWNER}/"
        f"{UPSTREAM_PROTO_REPO}/commits/{UPSTREAM_PROTO_BRANCH}"
    )
    sha_text = fetch_text(sha_url)
    upstream_sha = "?"
    if sha_text:
        try:
            upstream_sha = json.loads(sha_text).get("sha", "?")[:12]
        except json.JSONDecodeError:
            pass

    local_proto_path = VENDOR_PROTO_DIR / "src" / "parser.c"
    local_proto_text = local_proto_path.read_text(encoding="utf-8", errors="ignore") if local_proto_path.is_file() else ""
    in_sync = bool(
        upstream_proto_text
        and local_proto_text.replace("\r\n", "\n")
        == upstream_proto_text.replace("\r\n", "\n")
    )

    lines.append(f"- Upstream: `{UPSTREAM_PROTO_OWNER}/{UPSTREAM_PROTO_REPO}@{UPSTREAM_PROTO_BRANCH}` (HEAD `{upstream_sha}`)")
    lines.append(f"- Upstream ABI: **{upstream_proto_abi}**")
    lines.append(f"- Vendored ABI: **{vendored_abi}**")
    lines.append(f"- In sync: {'yes' if in_sync else 'no — upstream has diverged'}")

    if upstream_proto_abi and vendored_abi and upstream_proto_abi > vendored_abi:
        can_upgrade = upstream_proto_abi <= target_abi_range[1]
        lines.append(f"- Upstream ABI {upstream_proto_abi} {'is' if can_upgrade else 'is NOT'} within target runtime range ({target_abi_range[0]}..{target_abi_range[1]})")
        if can_upgrade:
            lines.append(f"- **Action:** regenerate vendored parser.c from upstream `{upstream_sha}` when proto parsing needs the upstream changes")
            upstream_blockers["vendored-proto-sync"] = "vendored tree-sitter-proto: upstream ABI-compatible changes are not yet mirrored"
        else:
            lines.append(f"- **Action:** wait for runtime upgrade beyond {TARGET_RUNTIME} that supports ABI {upstream_proto_abi}")
            runtime_blockers["vendored-proto-abi"] = f"vendored tree-sitter-proto: upstream ABI {upstream_proto_abi} outside target range"
    elif not in_sync:
        lines.append("- **Action:** review upstream changes; vendored copy may need updating")
        upstream_blockers["vendored-proto-sync"] = "vendored tree-sitter-proto: out of sync with upstream"

    # ── Summary ──────────────────────────────────────────────────────
    lines.append("")
    lines.append(md_h("Summary", 2))
    if runtime_blockers:
        lines.append(f"**{len(runtime_blockers)} runtime blocker(s) remaining:**\n")
        for b in runtime_blockers.values():
            lines.append(f"- {b}")
        lines.append("")
        lines.append("Current OntoIndex runtime compatibility with `tree-sitter@0.25` is **blocked**.")
    else:
        lines.append("Current OntoIndex runtime compatibility with `tree-sitter@0.25` is **ready**.")

    lines.append("")
    if upstream_blockers:
        lines.append(f"**{len(upstream_blockers)} upstream npm/de-vendoring blocker(s) remaining:**\n")
        for b in upstream_blockers.values():
            lines.append(f"- {b}")
        lines.append("")
        lines.append("Upstream npm-only install readiness is **blocked**; keep vendored grammar packages.")
    else:
        lines.append("All upstream npm grammars are compatible. Vendored grammar packages can be retired after review.")

    print("\n".join(lines))
    return 1 if (runtime_blockers or upstream_blockers) else 0


if __name__ == "__main__":
    sys.exit(main())
