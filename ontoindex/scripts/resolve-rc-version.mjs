import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const RC_VERSION = /^(\d+\.\d+\.\d+)-rc\.(\d+)$/;

function parseCore(version) {
  const match = CORE_VERSION.exec(version);
  if (!match) throw new Error(`invalid stable version: ${version}`);
  return match.slice(1).map(Number);
}

function compareCore(left, right) {
  const a = parseCore(left);
  const b = parseCore(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function incrementCore(version, bump) {
  const [major, minor, patch] = parseCore(version);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`invalid bump: ${bump}`);
}

function normalizeVersions(value) {
  if (!Array.isArray(value)) value = value == null ? [] : [value];
  return value.filter((version) => typeof version === 'string');
}

function directReleaseVersions(tags) {
  return tags
    .map(
      (tag) => /^v(.+)$/.exec(tag)?.[1] ?? /^rc-(?:pending|complete)\/[^/]+\/v(.+)$/.exec(tag)?.[1],
    )
    .filter((version) => typeof version === 'string');
}

export function resolveRcVersion({
  latestVersion,
  publishedVersions = [],
  gitTags = [],
  bump = 'auto',
  eventName = 'push',
  headSha,
}) {
  if (!headSha) throw new Error('headSha is required');

  const latest = latestVersion.split('-')[0];
  parseCore(latest);
  const versions = new Set([
    ...normalizeVersions(publishedVersions),
    ...directReleaseVersions(normalizeVersions(gitTags)),
  ]);

  const pendingPrefix = `rc-pending/${headSha}/v`;
  const completePrefix = `rc-complete/${headSha}/v`;
  const tags = normalizeVersions(gitTags);
  const completedVersions = new Set(
    tags
      .filter((tag) => tag.startsWith(completePrefix))
      .map((tag) => tag.slice(completePrefix.length)),
  );
  const pendingTags = tags.filter(
    (tag) =>
      tag.startsWith(pendingPrefix) && !completedVersions.has(tag.slice(pendingPrefix.length)),
  );
  if (pendingTags.length > 1) {
    throw new Error(`multiple pending rc markers for ${headSha}: ${pendingTags.join(', ')}`);
  }
  if (pendingTags.length === 1) {
    const pendingTag = pendingTags[0];
    const rcVersion = pendingTag.slice(pendingPrefix.length);
    const match = RC_VERSION.exec(rcVersion);
    if (!match) throw new Error(`invalid pending rc marker: ${pendingTag}`);
    return {
      base: match[1],
      rcN: Number(match[2]),
      rcVersion,
      vtag: `v${rcVersion}`,
      pendingTag,
      completeTag: `rc-complete/${headSha}/v${rcVersion}`,
      resume: true,
    };
  }

  let base;
  if (eventName === 'workflow_dispatch' && bump !== 'auto') {
    base = incrementCore(latest, bump);
  } else {
    const activeBases = [...versions]
      .map((version) => RC_VERSION.exec(version)?.[1])
      .filter((candidate) => candidate && compareCore(candidate, latest) > 0)
      .sort(compareCore);
    base = activeBases.at(-1) ?? incrementCore(latest, 'patch');
  }

  const counters = [...versions]
    .map((version) => RC_VERSION.exec(version))
    .filter((match) => match?.[1] === base)
    .map((match) => Number(match[2]));
  const rcN = counters.length === 0 ? 1 : Math.max(...counters) + 1;
  const rcVersion = `${base}-rc.${rcN}`;
  if (versions.has(rcVersion)) throw new Error(`rc version already exists: ${rcVersion}`);

  return {
    base,
    rcN,
    rcVersion,
    vtag: `v${rcVersion}`,
    pendingTag: `rc-pending/${headSha}/v${rcVersion}`,
    completeTag: `rc-complete/${headSha}/v${rcVersion}`,
    resume: false,
  };
}

function parsePublishedVersions(raw) {
  try {
    return normalizeVersions(JSON.parse(raw || '[]'));
  } catch (error) {
    throw new Error(`invalid PUBLISHED_VERSIONS_JSON: ${error.message}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = resolveRcVersion({
      latestVersion: process.env.LATEST_VERSION ?? '',
      publishedVersions: parsePublishedVersions(process.env.PUBLISHED_VERSIONS_JSON),
      gitTags: (process.env.GIT_TAGS ?? '').split(/\r?\n/).filter(Boolean),
      bump: process.env.BUMP_INPUT || 'auto',
      eventName: process.env.EVENT_NAME || 'push',
      headSha: process.env.HEAD_SHA,
    });
    for (const [key, value] of Object.entries(result)) {
      const outputKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      console.log(`${outputKey}=${value}`);
    }
  } catch (error) {
    console.error(`RC version resolution failed: ${error.message}`);
    process.exitCode = 1;
  }
}
