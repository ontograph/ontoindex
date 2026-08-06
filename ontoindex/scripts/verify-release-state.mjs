import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithRetry, verifyReleaseAsset } from './verify-release-asset.mjs';

const NPM_METADATA_ATTEMPTS = 20;
const GITHUB_METADATA_ATTEMPTS = 12;

export async function verifyReleaseState({
  packageName,
  version,
  distTag,
  repository,
  tag = `v${version}`,
  token,
  registry = 'https://registry.npmjs.org',
  fetchImpl = fetch,
  sleepImpl,
}) {
  if (!packageName || !version || !distTag) {
    throw new Error('packageName, version, and distTag are required');
  }

  const packagePath = packageName.startsWith('@')
    ? packageName.replace('/', '%2f')
    : encodeURIComponent(packageName);
  const versionResponse = await fetchWithRetry(
    `${registry}/${packagePath}/${encodeURIComponent(version)}`,
    { headers: { Accept: 'application/json' } },
    fetchImpl,
    sleepImpl,
    'npm version lookup',
    true,
    NPM_METADATA_ATTEMPTS,
  );
  const metadata = await versionResponse.json();
  if (metadata?.version !== version) {
    throw new Error(`npm returned version ${metadata?.version ?? 'missing'} instead of ${version}`);
  }

  const tagsResponse = await fetchWithRetry(
    `${registry}/-/package/${packagePath}/dist-tags`,
    { headers: { Accept: 'application/json' } },
    fetchImpl,
    sleepImpl,
    'npm dist-tag lookup',
    true,
    NPM_METADATA_ATTEMPTS,
  );
  const tags = await tagsResponse.json();
  if (tags?.[distTag] !== version) {
    throw new Error(
      `npm dist-tag ${distTag} points to ${tags?.[distTag] ?? 'missing'}, not ${version}`,
    );
  }

  const assetName = await verifyReleaseAsset({
    repository,
    tag,
    token,
    expectedPrerelease: true,
    metadataAttempts: GITHUB_METADATA_ATTEMPTS,
    fetchImpl,
    sleepImpl,
  });
  return { packageName, version, distTag, tag, assetName };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyReleaseState({
    packageName: process.env.NPM_PACKAGE_NAME,
    version: process.env.RELEASE_VERSION,
    distTag: process.env.NPM_DIST_TAG,
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.RELEASE_TAG,
    token: process.env.GITHUB_TOKEN,
  })
    .then(({ version, tag, assetName }) => {
      console.log(`Verified release state: npm ${version}, GitHub ${tag}, asset ${assetName}`);
    })
    .catch((error) => {
      console.error(`Release state verification failed: ${error.message}`);
      process.exitCode = 1;
    });
}
