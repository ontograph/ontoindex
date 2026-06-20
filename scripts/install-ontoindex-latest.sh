#!/usr/bin/env bash
set -euo pipefail

REPO="${ONTOINDEX_GITHUB_REPO:-ontograph/ontoindex}"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
USER_PREFIX="${ONTOINDEX_NPM_PREFIX:-${HOME}/.local}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 127
  fi
}

need curl
need node
need npm

node_major="$(node -p 'process.versions.node.split(".")[0]')"
node_minor="$(node -p 'process.versions.node.split(".")[1]')"
node_version="$(node -p 'process.versions.node')"
if [ "${node_major}" -lt 22 ] || { [ "${node_major}" -eq 22 ] && [ "${node_minor}" -lt 12 ]; }; then
  echo "error: OntoIndex supports Node.js 22.12.0 through Node.js 25.x for published installs." >&2
  echo "error: detected Node.js ${node_version}." >&2
  echo "error: commander@15 requires Node.js >=22.12.0, and Windows native installs need newer npm/node-gyp." >&2
  echo "error: recommended: use nvm to install and activate Node.js 22 LTS or newer before retrying." >&2
  exit 1
fi
if [ "${node_major}" -ge 26 ]; then
  echo "error: OntoIndex supports Node.js 22.12.0 through Node.js 25.x for published installs." >&2
  echo "error: detected Node.js ${node_major}.x." >&2
  echo "error: Node.js ${node_major}.x has not been validated with the vendored tree-sitter runtime yet." >&2
  echo "error: recommended: use nvm to install and activate Node.js 22 LTS, 24, or 25 before retrying." >&2
  exit 1
fi

write_linux_repair_instructions() {
  local prefix="${1}"
  local node_modules_root
  local package_dir
  local bin_path

  node_modules_root="$(npm root -g --prefix "${prefix}")"
  package_dir="${node_modules_root}/ontoindex"
  bin_path="${prefix}/bin/ontoindex"

  echo >&2
  echo "Repair commands for a broken partial install:" >&2
  echo "  npm uninstall -g ontoindex" >&2
  echo "  [ -d \"${package_dir}\" ] && rm -rf \"${package_dir}\"" >&2
  echo "  [ -f \"${bin_path}\" ] && rm -f \"${bin_path}\"" >&2
}

validate_install() {
  local prefix="${1}"
  local bin_path="${2}"
  local node_modules_root
  local package_dir
  local package_json
  local cli_path

  node_modules_root="$(npm root -g --prefix "${prefix}")"
  package_dir="${node_modules_root}/ontoindex"
  package_json="${package_dir}/package.json"
  cli_path="${package_dir}/dist/cli/index.js"

  if [ ! -f "${package_json}" ]; then
    echo "error: installed package metadata not found: ${package_json}" >&2
    write_linux_repair_instructions "${prefix}"
    exit 1
  fi

  if [ ! -f "${cli_path}" ]; then
    echo "error: installed CLI entrypoint not found: ${cli_path}" >&2
    write_linux_repair_instructions "${prefix}"
    exit 1
  fi

  (
    cd "${package_dir}"
    node -e "require('tree-sitter'); require('@ladybugdb/core')"
  ) || {
    echo "error: native dependency smoke test failed." >&2
    write_linux_repair_instructions "${prefix}"
    exit 1
  }

  "${bin_path}" --version || {
    echo "error: installed ontoindex command failed validation." >&2
    write_linux_repair_instructions "${prefix}"
    exit 1
  }
}

release_json="$(curl -fsSL "${API_URL}")"

asset_url="$(
  RELEASE_JSON="${release_json}" node <<'NODE'
const release = JSON.parse(process.env.RELEASE_JSON);
const asset = (release.assets || []).find((candidate) =>
  /^ontoindex-[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\.tgz$/.test(candidate.name),
);

if (!asset) {
  const tag = release.tag_name || "(unknown)";
  console.error(`error: no ontoindex tarball asset found on latest release ${tag}`);
  process.exit(1);
}

console.log(asset.browser_download_url);
NODE
)"

version="$(
  ASSET_URL="${asset_url}" node <<'NODE'
const match = /ontoindex-([^/]+)\.tgz$/.exec(process.env.ASSET_URL || "");
console.log(match ? match[1] : "unknown");
NODE
)"

default_prefix="$(npm config get prefix)"
install_args=(-g "${asset_url}")
bin_path=""
install_prefix="${default_prefix}"

if [ -w "${default_prefix}" ]; then
  echo "Installing OntoIndex ${version} from ${asset_url}"
  npm install "${install_args[@]}" || {
    write_linux_repair_instructions "${default_prefix}"
    exit 1
  }
  bin_path="$(command -v ontoindex || true)"
else
  mkdir -p "${USER_PREFIX}"
  echo "Default npm prefix is not writable: ${default_prefix}"
  echo "Installing OntoIndex ${version} into user prefix: ${USER_PREFIX}"
  npm install --prefix "${USER_PREFIX}" "${install_args[@]}" || {
    write_linux_repair_instructions "${USER_PREFIX}"
    exit 1
  }
  install_prefix="${USER_PREFIX}"
  bin_path="${USER_PREFIX}/bin/ontoindex"
fi

if [ ! -x "${bin_path}" ]; then
  echo "error: installed ontoindex binary not found: ${bin_path}" >&2
  write_linux_repair_instructions "${install_prefix}"
  exit 1
fi

echo "Installed OntoIndex:"
validate_install "${install_prefix}" "${bin_path}"

case ":${PATH}:" in
  *":${USER_PREFIX}/bin:"*) ;;
  *)
    if [ "${bin_path}" = "${USER_PREFIX}/bin/ontoindex" ]; then
      echo "Add this to your shell profile if you want to run ontoindex directly:"
      echo "export PATH=\"${USER_PREFIX}/bin:\$PATH\""
    fi
    ;;
esac
