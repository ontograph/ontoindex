#!/usr/bin/env bash
set -euo pipefail

REPO="${ONTOINDEX_GITHUB_REPO:-ontograph/ontoindex}"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
USER_PREFIX="${ONTOINDEX_NPM_PREFIX:-${HOME}/.local}"
LADYBUG_EXTENSIONS_REPO="${ONTOINDEX_LADYBUG_EXTENSIONS_REPO:-ontograph/ontoindex}"
LADYBUG_EXTENSIONS_TAG="${ONTOINDEX_LADYBUG_EXTENSIONS_TAG:-ladybugdb-extensions-v0.17.0-linux-amd64}"
LADYBUG_EXTENSIONS_CACHE="${ONTOINDEX_LADYBUG_EXTENSIONS_CACHE:-${XDG_CACHE_HOME:-${HOME}/.cache}/ontoindex/ladybugdb-extensions/v0.17.0/linux_amd64}"
WGET_CONNECT_TIMEOUT="${ONTOINDEX_INSTALL_WGET_CONNECT_TIMEOUT:-${ONTOINDEX_INSTALL_CURL_CONNECT_TIMEOUT:-10}}"
WGET_RETRY_COUNT="${ONTOINDEX_INSTALL_WGET_RETRIES:-${ONTOINDEX_INSTALL_CURL_RETRIES:-2}}"
WGET_RETRY_DELAY="${ONTOINDEX_INSTALL_WGET_RETRY_DELAY:-${ONTOINDEX_INSTALL_CURL_RETRY_DELAY:-1}}"
WGET_MAX_TIME_RELEASE="${ONTOINDEX_INSTALL_RELEASE_MAX_TIME:-${ONTOINDEX_INSTALL_CURL_MAX_TIME_RELEASE:-45}}"
WGET_MAX_TIME_DOWNLOAD="${ONTOINDEX_INSTALL_DOWNLOAD_MAX_TIME:-${ONTOINDEX_INSTALL_CURL_MAX_TIME_DOWNLOAD:-120}}"

SCRIPT_DIR=""
if [ "${BASH_SOURCE[0]:-}" != "" ] && [ -e "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
fi

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 127
  fi
}

need node
need npm

has_command() {
  command -v "$1" >/dev/null 2>&1
}

if ! has_command wget && ! has_command curl; then
  echo "error: required downloader not found: install wget or curl" >&2
  exit 127
fi

wget_args() {
  local max_time="${1}"
  local tries=$((WGET_RETRY_COUNT + 1))
  printf '%s\n' \
    --tries="${tries}" \
    --waitretry="${WGET_RETRY_DELAY}" \
    --read-timeout="${max_time}" \
    --timeout="${WGET_CONNECT_TIMEOUT}" \
    --user-agent=ontoindex-installer
}

wget_to_stdout() {
  local max_time="${1}"
  local url="${2}"
  if has_command wget; then
    wget $(wget_args "${max_time}") -qO- "${url}" && return 0
    log "wget failed for ${url}; retrying with curl"
  fi
  curl -fsSL \
    --retry "${WGET_RETRY_COUNT}" \
    --retry-delay "${WGET_RETRY_DELAY}" \
    --retry-all-errors \
    --connect-timeout "${WGET_CONNECT_TIMEOUT}" \
    --max-time "${max_time}" \
    -A ontoindex-installer \
    "${url}"
}

wget_to_file() {
  local max_time="${1}"
  local output="${2}"
  local url="${3}"
  if has_command wget; then
    wget $(wget_args "${max_time}") -O "${output}" "${url}" && return 0
    log "wget failed for ${url}; retrying with curl"
  fi
  curl -fL \
    --retry "${WGET_RETRY_COUNT}" \
    --retry-delay "${WGET_RETRY_DELAY}" \
    --retry-all-errors \
    --connect-timeout "${WGET_CONNECT_TIMEOUT}" \
    --max-time "${max_time}" \
    -A ontoindex-installer \
    -o "${output}" \
    "${url}"
}

find_local_asset() {
  local candidate dir

  if [ "${ONTOINDEX_LOCAL_ASSET:-}" != "" ]; then
    candidate="${ONTOINDEX_LOCAL_ASSET}"
    if [ -f "${candidate}" ]; then
      (
        cd "$(dirname "${candidate}")"
        pwd -P
      ) | {
        read -r abs_dir
        printf '%s/%s\n' "${abs_dir}" "$(basename "${candidate}")"
      }
      return 0
    fi
    echo "error: ONTOINDEX_LOCAL_ASSET does not exist: ${candidate}" >&2
    exit 1
  fi

  for dir in "${PWD}" "${SCRIPT_DIR}"; do
    [ -n "${dir}" ] || continue
    candidate="$(ls -1t "${dir}"/ontoindex-*.tgz 2>/dev/null | head -n1 || true)"
    if [ -n "${candidate}" ]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  return 1
}

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
    if [ -f libfts.lbug_extension ] && [ -f libvector.lbug_extension ]; then
      if [ -f SHA256SUMS.txt ] && command -v sha256sum >/dev/null 2>&1; then
        if sha256sum -c SHA256SUMS.txt >/dev/null 2>&1; then
          log "Using cached LadybugDB extensions; checksums already valid"
          exit 0
        fi
        log "Cached LadybugDB extensions failed checksum; refreshing"
      else
        log "Using cached LadybugDB extensions; checksum file is not present"
        exit 0
      fi
    fi

    log "Downloading LadybugDB extension checksums from ${base_url}"
    wget_to_file "${WGET_MAX_TIME_DOWNLOAD}" SHA256SUMS.txt "${base_url}/SHA256SUMS.txt"

    for asset in libfts.lbug_extension libvector.lbug_extension; do
      if [ -f "${asset}" ] && command -v sha256sum >/dev/null 2>&1 && grep " ${asset}$" SHA256SUMS.txt | sha256sum -c - >/dev/null 2>&1; then
        log "Using cached ${asset}"
        continue
      fi
      if [ -f "${asset}" ] && command -v sha256sum >/dev/null 2>&1; then
        rm -f "${asset}"
      fi
      log "Downloading ${asset}"
      wget_to_file "${WGET_MAX_TIME_DOWNLOAD}" "${asset}" "${base_url}/${asset}"
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
  local resolved_command

  node_modules_root="$(npm root -g --prefix "${prefix}")"
  package_dir="${node_modules_root}/ontoindex"
  bin_path="${prefix}/bin/ontoindex"

  if [ -d "${package_dir}" ] || [ -f "${bin_path}" ]; then
    log "Removing previous OntoIndex install from ${prefix}"
    rm -rf "${package_dir}" "${bin_path}"
  fi

  resolved_command="$(command -v ontoindex 2>/dev/null || true)"
  if [ -n "${resolved_command}" ] && [ -L "${resolved_command}" ] && [ ! -e "${resolved_command}" ]; then
    log "Removing broken ontoindex shim from PATH: ${resolved_command}"
    rm -f "${resolved_command}"
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

asset_url="$(find_local_asset || true)"
if [ -n "${asset_url}" ]; then
  log "Using local OntoIndex tarball: ${asset_url}"
else
  log "Fetching latest OntoIndex release metadata from ${API_URL}"
  release_json="$(wget_to_stdout "${WGET_MAX_TIME_RELEASE}" "${API_URL}")"

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
fi

version="$(
  ASSET_URL="${asset_url}" node <<'NODE'
const match = /ontoindex-([^/]+)\.tgz$/.exec(process.env.ASSET_URL || "");
console.log(match ? match[1] : "unknown");
NODE
)"

log "Selected OntoIndex ${version} asset: ${asset_url}"
default_prefix="$(npm config get prefix)"
install_asset="${asset_url}"
temp_asset_dir=""
cleanup_temp_asset() {
  [ -n "${temp_asset_dir}" ] && rm -rf "${temp_asset_dir}"
}
trap cleanup_temp_asset EXIT

if [ ! -f "${asset_url}" ]; then
  temp_asset_dir="$(mktemp -d)"
  install_asset="${temp_asset_dir}/$(basename "${asset_url}")"
  log "Downloading release asset to a temporary file: ${install_asset}"
  wget_to_file "${WGET_MAX_TIME_DOWNLOAD}" "${install_asset}" "${asset_url}" || {
    rm -rf "${temp_asset_dir}"
    exit 1
  }
  if [ ! -s "${install_asset}" ]; then
    echo "error: downloaded release asset is empty: ${install_asset}" >&2
    rm -rf "${temp_asset_dir}"
    exit 1
  fi
fi
install_args=(-g "${install_asset}")
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
echo ""
echo "Next step: run 'ontoindex setup' after installation to configure MCP clients and agent guidance."
echo "The setup command is idempotent and will not duplicate existing OntoIndex settings."
if [ "${install_prefix}" = "${USER_PREFIX}" ] && ! printf '%s' ":${PATH}:" | grep -Fq ":${USER_PREFIX}/bin:"; then
  echo "Add ${USER_PREFIX}/bin to PATH to use ontoindex in new shells."
fi

case ":${PATH}:" in
  *":${USER_PREFIX}/bin:"*) ;;
  *)
    if [ "${bin_path}" = "${USER_PREFIX}/bin/ontoindex" ]; then
      echo "Add this to your shell profile if you want to run ontoindex directly:"
      echo "export PATH=\"${USER_PREFIX}/bin:\$PATH\""
    fi
    ;;
esac
