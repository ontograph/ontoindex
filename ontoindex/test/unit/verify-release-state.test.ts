import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyReleaseState } from '../../scripts/verify-release-state.mjs';

const tempDirs: string[] = [];

function createTarball(version: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-state-test-'));
  tempDirs.push(root);
  const packageDir = path.join(root, 'package');
  fs.mkdirSync(path.join(packageDir, 'dist/cli'), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ version, bin: { ontoindex: 'dist/cli/index.js' } }),
  );
  fs.writeFileSync(path.join(packageDir, 'dist/cli/index.js'), '#!/usr/bin/env node\n');
  const tarball = path.join(root, 'fixture.tgz');
  const result = spawnSync('tar', ['-czf', tarball, '-C', root, 'package'], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return fs.readFileSync(tarball);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('verifyReleaseState', () => {
  it('verifies npm metadata, the dist-tag, the GitHub release, and its tarball', async () => {
    const version = '2.1.5-rc.2';
    const assetName = `ontoindex-${version}.tgz`;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rc: version })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            prerelease: true,
            assets: [
              { name: assetName, browser_download_url: `https://example.test/${assetName}` },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(createTarball(version)));

    await expect(
      verifyReleaseState({
        packageName: 'ontoindex',
        version,
        distTag: 'rc',
        repository: 'ontograph/ontoindex',
        fetchImpl,
      }),
    ).resolves.toMatchObject({ version, tag: `v${version}`, assetName });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('fails before GitHub verification when the npm dist-tag is wrong', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '2.1.5-rc.2' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rc: '2.1.5-rc.1' })));

    await expect(
      verifyReleaseState({
        packageName: 'ontoindex',
        version: '2.1.5-rc.2',
        distTag: 'rc',
        repository: 'ontograph/ontoindex',
        fetchImpl,
        sleepImpl: vi.fn(),
      }),
    ).rejects.toThrow('npm dist-tag rc points to 2.1.5-rc.1, not 2.1.5-rc.2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails when the GitHub release is not marked as a prerelease', async () => {
    const version = '2.1.5-rc.2';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rc: version })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ prerelease: false, assets: [] })));

    await expect(
      verifyReleaseState({
        packageName: 'ontoindex',
        version,
        distTag: 'rc',
        repository: 'ontograph/ontoindex',
        fetchImpl,
      }),
    ).rejects.toThrow('GitHub release prerelease=false; expected true');
  });

  it('retries an eventually consistent npm version lookup', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    await expect(
      verifyReleaseState({
        packageName: 'ontoindex',
        version: '2.1.5-rc.2',
        distTag: 'rc',
        repository: 'ontograph/ontoindex',
        fetchImpl,
        sleepImpl,
      }),
    ).rejects.toThrow('npm version lookup failed: 404 after 20 attempts');
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    expect(sleepImpl).toHaveBeenCalledTimes(19);
  });
});
