import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyReleaseAsset } from '../../scripts/verify-release-asset.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tempDirs: string[] = [];

function createTarball(
  version = '2.1.2',
  bin: unknown = { ontoindex: 'dist/cli/index.js' },
  includeCli = true,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-asset-test-'));
  tempDirs.push(root);
  const packageDir = path.join(root, 'package');
  fs.mkdirSync(path.join(packageDir, 'dist/cli'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version, bin }));
  if (includeCli) {
    fs.writeFileSync(path.join(packageDir, 'dist/cli/index.js'), '#!/usr/bin/env node\n');
  }
  const tarball = path.join(root, 'fixture.tgz');
  const result = spawnSync('tar', ['-czf', tarball, '-C', root, 'package'], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return fs.readFileSync(tarball);
}

function release(assets: unknown[]) {
  return new Response(JSON.stringify({ assets }), {
    headers: { 'content-type': 'application/json' },
  });
}

function response(status: number, headers?: Record<string, string>) {
  return new Response('', { status, headers });
}

function asset(name = 'ontoindex-2.1.2.tgz') {
  return { name, browser_download_url: `https://downloads.example/${name}` };
}

function fetchFixture(assets: unknown[], tarball = createTarball()) {
  return vi
    .fn()
    .mockResolvedValueOnce(release(assets))
    .mockResolvedValueOnce(new Response(tarball));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('verifyReleaseAsset', () => {
  it('accepts exactly one expected release asset with the matching package and CLI', async () => {
    const fetchImpl = fetchFixture([asset()]);

    await expect(
      verifyReleaseAsset({ repository: 'ontograph/ontoindex', tag: 'v2.1.2', fetchImpl }),
    ).resolves.toBe('ontoindex-2.1.2.tgz');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/ontograph/ontoindex/releases/tags/v2.1.2',
      expect.anything(),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://downloads.example/ontoindex-2.1.2.tgz', {
      headers: { 'User-Agent': 'ontoindex-release-verifier' },
    });
  });

  it.each([
    ['absent', []],
    ['duplicate', [asset(), asset()]],
    ['wrong version', [asset('ontoindex-2.1.3.tgz')]],
    ['expected plus stale', [asset(), asset('ontoindex-2.1.1.tgz')]],
  ])('fails when the installer asset set is %s', async (_name, assets) => {
    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl: fetchFixture(assets),
      }),
    ).rejects.toThrow('expected only ontoindex-2.1.2.tgz');
  });

  it.each([
    ['malformed JSON', new Response('{', { status: 200 })],
    ['non-object JSON', new Response('[]', { status: 200 })],
    ['missing assets', new Response('{}', { status: 200 })],
  ])('fails closed on %s release metadata', async (_name, metadata) => {
    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl: vi.fn().mockResolvedValue(metadata),
      }),
    ).rejects.toThrow();
  });

  it('retries a tag-specific 404 and then succeeds', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(release([asset()]))
      .mockResolvedValueOnce(new Response(createTarball()));

    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl,
        sleepImpl,
      }),
    ).resolves.toBe('ontoindex-2.1.2.tgz');
    expect(sleepImpl).toHaveBeenCalledWith(250);
  });

  it.each([429, 500, 503])('fails after bounded retries for HTTP %s', async (status) => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(response(status, { 'Retry-After': '99' }));

    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl,
        sleepImpl,
      }),
    ).rejects.toThrow(`GitHub release lookup failed: ${status} after 4 attempts`);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleepImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledWith(5_000);
  });

  it('retries metadata HTTP 403 with Retry-After and then succeeds', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(403, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(release([asset()]))
      .mockResolvedValueOnce(new Response(createTarball()));

    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl,
        sleepImpl,
      }),
    ).resolves.toBe('ontoindex-2.1.2.tgz');
    expect(sleepImpl).toHaveBeenCalledWith(1_000);
  });

  it('exhausts metadata HTTP 403 with Retry-After retries', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(response(403, { 'Retry-After': '1' }));

    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl,
        sleepImpl,
      }),
    ).rejects.toThrow('GitHub release lookup failed: 403 after 4 attempts');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleepImpl).toHaveBeenCalledTimes(3);
  });

  it('retries a rejected metadata fetch and then succeeds', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(release([asset()]))
      .mockResolvedValueOnce(new Response(createTarball()));

    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl,
        sleepImpl,
      }),
    ).resolves.toBe('ontoindex-2.1.2.tgz');
    expect(sleepImpl).toHaveBeenCalledWith(250);
  });

  it('exhausts rejected metadata fetch retries', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection reset'));

    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl,
        sleepImpl,
      }),
    ).rejects.toThrow('GitHub release lookup failed after 4 attempts: connection reset');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleepImpl).toHaveBeenCalledTimes(3);
  });

  it('sends the token header and encodes the tag-specific endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(release([]));

    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2/test',
        token: 'secret',
        fetchImpl,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/ontograph/ontoindex/releases/tags/v2.1.2%2Ftest',
      {
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      },
    );
  });

  it('fails when the tarball package version does not match the tag', async () => {
    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl: fetchFixture([asset()], createTarball('2.1.3')),
      }),
    ).rejects.toThrow('tarball version 2.1.3 does not match 2.1.2');
  });

  it('fails when the tarball is missing the CLI bin entry', async () => {
    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl: fetchFixture([asset()], createTarball('2.1.2', {})),
      }),
    ).rejects.toThrow('tarball is missing bin entry ontoindex: dist/cli/index.js');
  });

  it('fails when the tarball is missing the CLI file', async () => {
    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl: fetchFixture(
          [asset()],
          createTarball('2.1.2', { ontoindex: 'dist/cli/index.js' }, false),
        ),
      }),
    ).rejects.toThrow('tarball is missing package/dist/cli/index.js');
  });

  it('fails on a corrupt tarball', async () => {
    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl: fetchFixture([asset()], Buffer.from('not a tarball')),
      }),
    ).rejects.toThrow();
  });

  it.each([500, 503])('retries download HTTP %s and then succeeds', async (status) => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(release([asset()]))
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(new Response(createTarball()));

    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl,
        sleepImpl,
      }),
    ).resolves.toBe('ontoindex-2.1.2.tgz');
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it('exhausts download HTTP 5xx retries', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(release([asset()]))
      .mockResolvedValue(response(502));

    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl,
        sleepImpl,
      }),
    ).rejects.toThrow('release asset download failed: 502 after 4 attempts');
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(sleepImpl).toHaveBeenCalledTimes(3);
  });

  it('retries a rejected release asset download and then succeeds', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(release([asset()]))
      .mockRejectedValueOnce(new Error('download interrupted'))
      .mockResolvedValueOnce(new Response(createTarball()));

    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl,
        sleepImpl,
      }),
    ).resolves.toBe('ontoindex-2.1.2.tgz');
    expect(sleepImpl).toHaveBeenCalledWith(250);
  });

  it('exhausts rejected release asset download retries', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(release([asset()]))
      .mockRejectedValue(new Error('download interrupted'));

    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl,
        sleepImpl,
      }),
    ).rejects.toThrow('release asset download failed after 4 attempts: download interrupted');
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(sleepImpl).toHaveBeenCalledTimes(3);
  });

  it('retries download HTTP 403 with Retry-After and then succeeds', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(release([asset()]))
      .mockResolvedValueOnce(response(403, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(new Response(createTarball()));

    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl,
        sleepImpl,
      }),
    ).resolves.toBe('ontoindex-2.1.2.tgz');
    expect(sleepImpl).toHaveBeenCalledWith(1_000);
  });

  it('exhausts download HTTP 403 with Retry-After retries', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(release([asset()]))
      .mockResolvedValue(response(403, { 'Retry-After': '1' }));

    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl,
        sleepImpl,
      }),
    ).rejects.toThrow('release asset download failed: 403 after 4 attempts');
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(sleepImpl).toHaveBeenCalledTimes(3);
  });

  it('fails a permanent download HTTP 4xx after one attempt', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(release([asset()]))
      .mockResolvedValueOnce(response(404));

    await expect(
      verifyReleaseAsset({
        repository: 'ontograph/ontoindex',
        tag: 'v2.1.2',
        fetchImpl,
        sleepImpl,
      }),
    ).rejects.toThrow('release asset download failed: 404');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it('keeps stable version validation before release creation and npm publication', () => {
    const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/publish.yml'), 'utf8');
    expect(workflow).toContain('[[ "$TAG_VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]');
    expect(workflow).toContain('without prerelease suffixes');
    expect(workflow).not.toContain('(-[a-zA-Z0-9.]+)?');

    const versionCheck = workflow.indexOf('- name: Verify version consistency');
    const createRelease = workflow.indexOf('- name: Create GitHub Release');
    const verifyAsset = workflow.indexOf('- name: Verify live GitHub release asset');
    const publish = workflow.indexOf('- name: Publish to npm');
    expect(versionCheck).toBeLessThan(createRelease);
    expect(createRelease).toBeLessThan(verifyAsset);
    expect(verifyAsset).toBeLessThan(publish);
  });
});
