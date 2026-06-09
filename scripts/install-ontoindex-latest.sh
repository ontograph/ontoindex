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

if [ -w "${default_prefix}" ]; then
  echo "Installing OntoIndex ${version} from ${asset_url}"
  npm install "${install_args[@]}"
  bin_path="$(command -v ontoindex || true)"
else
  mkdir -p "${USER_PREFIX}"
  echo "Default npm prefix is not writable: ${default_prefix}"
  echo "Installing OntoIndex ${version} into user prefix: ${USER_PREFIX}"
  npm install --prefix "${USER_PREFIX}" "${install_args[@]}"
  bin_path="${USER_PREFIX}/bin/ontoindex"
fi

if [ ! -x "${bin_path}" ]; then
  echo "error: installed ontoindex binary not found: ${bin_path}" >&2
  exit 1
fi

echo "Installed OntoIndex:"
"${bin_path}" --version

case ":${PATH}:" in
  *":${USER_PREFIX}/bin:"*) ;;
  *)
    if [ "${bin_path}" = "${USER_PREFIX}/bin/ontoindex" ]; then
      echo "Add this to your shell profile if you want to run ontoindex directly:"
      echo "export PATH=\"${USER_PREFIX}/bin:\$PATH\""
    fi
    ;;
esac
