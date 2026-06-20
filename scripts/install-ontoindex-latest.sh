#!/usr/bin/env bash
set -euo pipefail

REPO="${ONTOINDEX_GITHUB_REPO:-ontograph/ontoindex}"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
USER_PREFIX="${ONTOINDEX_NPM_PREFIX:-${HOME}/.local}"
LADYBUG_EXTENSIONS_REPO="${ONTOINDEX_LADYBUG_EXTENSIONS_REPO:-ontograph/ontoindex}"
LADYBUG_EXTENSIONS_TAG="${ONTOINDEX_LADYBUG_EXTENSIONS_TAG:-ladybugdb-extensions-v0.17.0-linux-amd64}"
LADYBUG_EXTENSIONS_CACHE="${ONTOINDEX_LADYBUG_EXTENSIONS_CACHE:-${XDG_CACHE_HOME:-${HOME}/.cache}/ontoindex/ladybugdb-extensions/v0.17.0/linux_amd64}"

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 127
  fi
}

need curl
need node
need npm

download_ladybug_extensions() {
  if [ "${ONTOINDEX_SKIP_LADYBUG_EXTENSIONS:-0}" = "1" ]; then
    log "Skipping LadybugDB extension cache prefetch: ONTOINDEX_SKIP_LADYBUG_EXTENSIONS=1"
    return 0
  fi

  local os arch require base_url cache
  os="$(uname -s 2>/dev/null || true)"
  arch="$(uname -m 2>/dev/null || true)"
  require="${ONTOINDEX_REQUIRE_LADYBUG_EXTENSIONS:-0}"

  if [ "${os}" != "Linux" ] || { [ "${arch}" != "x86_64" ] && [ "${arch}" != "amd64" ]; }; then
    log "Skipping LadybugDB extension cache prefetch: unsupported platform ${os}/${arch}."
    return 0
  fi

  cache="${LADYBUG_EXTENSIONS_CACHE}"
  base_url="https://github.com/${LADYBUG_EXTENSIONS_REPO}/releases/download/${LADYBUG_EXTENSIONS_TAG}"

  mkdir -p "${cache}"
  log "Prefetching LadybugDB fts/vector extensions into ${cache}"

  (
    cd "${cache}"
    log "Downloading LadybugDB extension checksums from ${base_url}"
    curl -fL --retry 10 --retry-all-errors --connect-timeout 20 --max-time 300 \
      -o SHA256SUMS.txt "${base_url}/SHA256SUMS.txt"

    for asset in libfts.lbug_extension libvector.lbug_extension; do
      if [ -f "${asset}" ] && command -v sha256sum >/dev/null 2>&1 && grep " ${asset}$" SHA256SUMS.txt | sha256sum -c - >/dev/null 2>&1; then
        log "Using cached ${asset}"
        continue
      fi
      if [ -f "${asset}" ] && command -v sha256sum >/dev/null 2>&1; then
        rm -f "${asset}"
      fi
      log "Downloading ${asset}"
      curl -fL --retry 10 --retry-all-errors --connect-timeout 20 --max-time 300 --continue-at - \
        -o "${asset}" "${base_url}/${asset}"
    done

    if command -v sha256sum >/dev/null 2>&1; then
      log "Verifying LadybugDB extension checksums"
      sha256sum -c SHA256SUMS.txt
    fi
  ) || {
    echo "warning: LadybugDB extension prefetch failed; OntoIndex install will continue." >&2
    echo "warning: rerun with ONTOINDEX_REQUIRE_LADYBUG_EXTENSIONS=1 to make this fatal." >&2
    [ "${require}" = "1" ] && exit 1
    return 0
  }
}

node_major="$(node -p 'process.versions.node.split(".")[0]')"
node_minor="$(node -p 'process.versions.node.split(".")[1]')"
node_version="$(node -p 'process.versions.node')"
log "Detected Node.js ${node_version}, npm $(npm --version)"
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

download_ladybug_extensions

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

remove_existing_install() {
  local prefix="${1}"
  local node_modules_root
  local package_dir
  local bin_path

  node_modules_root="$(npm root -g --prefix "${prefix}")"
  package_dir="${node_modules_root}/ontoindex"
  bin_path="${prefix}/bin/ontoindex"

  if [ -d "${package_dir}" ] || [ -f "${bin_path}" ]; then
    log "Removing previous OntoIndex install from ${prefix}"
    rm -rf "${package_dir}" "${bin_path}"
  fi
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

  log "Validating installed package under ${package_dir}"
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

  log "Running native dependency smoke test"
  (
    cd "${package_dir}"
    node -e "require('tree-sitter'); require('@ladybugdb/core')"
  ) || {
    echo "error: native dependency smoke test failed." >&2
    write_linux_repair_instructions "${prefix}"
    exit 1
  }

  log "Running ontoindex --version"
  "${bin_path}" --version || {
    echo "error: installed ontoindex command failed validation." >&2
    write_linux_repair_instructions "${prefix}"
    exit 1
  }
}

log "Fetching latest OntoIndex release metadata from ${API_URL}"
release_json="$(curl -fsSL --connect-timeout 20 --max-time 120 "${API_URL}")"

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

log "Selected OntoIndex ${version} asset: ${asset_url}"
default_prefix="$(npm config get prefix)"
install_args=(-g "${asset_url}")
bin_path=""
install_prefix="${default_prefix}"
log "npm global prefix: ${default_prefix}"

if [ -w "${default_prefix}" ]; then
  log "Installing OntoIndex ${version} from ${asset_url}"
  remove_existing_install "${default_prefix}"
  log "Running npm install -g; native package install can take a few minutes"
  npm install "${install_args[@]}" || {
    write_linux_repair_instructions "${default_prefix}"
    exit 1
  }
  bin_path="$(command -v ontoindex || true)"
else
  mkdir -p "${USER_PREFIX}"
  log "Default npm prefix is not writable: ${default_prefix}"
  log "Installing OntoIndex ${version} into user prefix: ${USER_PREFIX}"
  remove_existing_install "${USER_PREFIX}"
  log "Running npm install --prefix ${USER_PREFIX} -g; native package install can take a few minutes"
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

log "Installed OntoIndex:"
validate_install "${install_prefix}" "${bin_path}"

log "Install complete."
echo "Note: this installer uses npm to resolve third-party runtime packages."
echo "A non-fatal npm warning about deprecated transitive packages can appear while upstream packages catch up."
echo "For air-gapped installs, use a separately prepared npm cache or internal registry mirror."

case ":${PATH}:" in
  *":${USER_PREFIX}/bin:"*) ;;
  *)
    if [ "${bin_path}" = "${USER_PREFIX}/bin/ontoindex" ]; then
      echo "Add this to your shell profile if you want to run ontoindex directly:"
      echo "export PATH=\"${USER_PREFIX}/bin:\$PATH\""
    fi
    ;;
esac
