import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_ASSET_PATTERN = /^ontoindex-[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\.tgz$/;
const MAX_METADATA_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 5_000;

function retryDelay(response, attempt) {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay)) return Math.min(Math.max(delay, 0), MAX_RETRY_DELAY_MS);
  }
  return Math.min(attempt * 250, MAX_RETRY_DELAY_MS);
}

function retryableResponse(response, retry404) {
  return (
    (retry404 && response.status === 404) ||
    response.status === 429 ||
    (response.status === 403 && response.headers.has('retry-after')) ||
    (response.status >= 500 && response.status <= 599)
  );
}

export function parseTarEntries(output) {
  return output.split(/\r?\n/).map((entry) => entry.replaceAll('\\', '/'));
}

export async function fetchWithRetry(
  url,
  options,
  fetchImpl,
  sleepImpl = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  label,
  retry404 = false,
  maxAttempts = MAX_METADATA_ATTEMPTS,
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, options);
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`${label} failed after ${attempt} attempts: ${error.message}`);
      }
      await sleepImpl(retryDelay(undefined, attempt));
      continue;
    }

    if (response.ok) return response;

    const retryable = retryableResponse(response, retry404);
    if (!retryable || attempt === maxAttempts) {
      throw new Error(
        `${label} failed: ${response.status}${retryable ? ` after ${attempt} attempts` : ''}`,
      );
    }
    await sleepImpl(retryDelay(response, attempt));
  }
}

export async function verifyReleaseAsset({
  repository,
  tag,
  token,
  expectedPrerelease,
  metadataAttempts = MAX_METADATA_ATTEMPTS,
  fetchImpl = fetch,
  sleepImpl = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
}) {
  if (!repository || !tag?.startsWith('v'))
    throw new Error('repository and v-prefixed tag are required');

  const version = tag.slice(1);
  const assetName = `ontoindex-${version}.tgz`;
  const apiHeaders = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ontoindex-release-verifier',
  };
  if (token) apiHeaders.Authorization = `Bearer ${token}`;

  const releaseResponse = await fetchWithRetry(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    { headers: apiHeaders },
    fetchImpl,
    sleepImpl,
    'GitHub release lookup',
    true,
    metadataAttempts,
  );
  let release;
  try {
    release = await releaseResponse.json();
  } catch (error) {
    throw new Error(`GitHub release JSON is invalid: ${error.message}`);
  }
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('GitHub release JSON must be an object');
  }
  if (expectedPrerelease !== undefined && release.prerelease !== expectedPrerelease) {
    throw new Error(
      `GitHub release prerelease=${String(release.prerelease)}; expected ${expectedPrerelease}`,
    );
  }
  if (!Array.isArray(release.assets)) throw new Error('GitHub release assets are missing');
  const assets = release.assets.filter(
    (asset) => typeof asset?.name === 'string' && RELEASE_ASSET_PATTERN.test(asset.name),
  );
  if (assets.length !== 1 || assets[0].name !== assetName) {
    throw new Error(
      `expected only ${assetName}; found ${assets.map((asset) => asset.name).join(', ') || 'none'}`,
    );
  }
  if (typeof assets[0].browser_download_url !== 'string' || !assets[0].browser_download_url) {
    throw new Error(`${assetName} has no download URL`);
  }

  const downloadResponse = await fetchWithRetry(
    assets[0].browser_download_url,
    { headers: { 'User-Agent': 'ontoindex-release-verifier' } },
    fetchImpl,
    sleepImpl,
    'release asset download',
  );

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-release-'));
  const tarball = path.join(tempDir, assetName);
  try {
    await fs.writeFile(tarball, Buffer.from(await downloadResponse.arrayBuffer()));
    const packageJson = JSON.parse(
      execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
    );
    if (packageJson.version !== version) {
      throw new Error(`tarball version ${packageJson.version} does not match ${version}`);
    }
    if (packageJson.bin?.ontoindex !== 'dist/cli/index.js') {
      throw new Error('tarball is missing bin entry ontoindex: dist/cli/index.js');
    }

    const entries = parseTarEntries(execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }));
    if (!entries.includes('package/dist/cli/index.js')) {
      throw new Error('tarball is missing package/dist/cli/index.js');
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  return assetName;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyReleaseAsset({
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.GITHUB_REF_NAME,
    token: process.env.GITHUB_TOKEN,
  })
    .then((assetName) => console.log(`Verified live GitHub release asset: ${assetName}`))
    .catch((error) => {
      console.error(`Release asset verification failed: ${error.message}`);
      process.exitCode = 1;
    });
}
