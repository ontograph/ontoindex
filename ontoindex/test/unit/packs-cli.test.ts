import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const initMock = vi.fn();
const callToolMock = vi.fn();
const writeSyncMock = vi.fn();

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    init = initMock;
    callTool = callToolMock;
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeSync: writeSyncMock };
});

describe('packs CLI commands', () => {
  const tmpDirs: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    initMock.mockReset();
    callToolMock.mockReset();
    writeSyncMock.mockReset();
    initMock.mockResolvedValue(true);
  });

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function createRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-packs-cli-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('lists packs from ontoindex-packs', async () => {
    const repoDir = await createRepo();
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/demo-pack'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/demo-pack/pack.yml'),
      [
        'schema: 1',
        'id: demo.pack',
        'name: Demo Pack',
        'version: 0.1.0',
        'kind: query',
        'tier: stable',
        'summary: Demo pack.',
      ].join('\n'),
      'utf8',
    );

    const { listPacksCommand } = await import('../../src/cli/packs.js');
    await listPacksCommand({ path: repoDir });

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('demo.pack'));
  });

  it('describes a suite execution plan', async () => {
    const repoDir = await createRepo();
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/demo-pack'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/suites/demo-suite'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/demo-pack/pack.yml'),
      [
        'schema: 1',
        'id: demo.pack',
        'name: Demo Pack',
        'version: 0.1.0',
        'kind: query',
        'tier: stable',
        'summary: Demo pack.',
        'runs:',
        '  - tool: graph_diff',
        '    params:',
        '      limit: 5',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/suites/demo-suite/suite.yml'),
      [
        'schema: 1',
        'id: suite.demo',
        'name: Demo Suite',
        'tier: stable',
        'summary: Demo suite.',
        'packs:',
        '  - demo.pack',
      ].join('\n'),
      'utf8',
    );

    const { describePackCommand } = await import('../../src/cli/packs.js');
    await describePackCommand('suite.demo', { path: repoDir });

    const output = String(writeSyncMock.mock.calls[0][1]);
    expect(output).toContain('suite: suite.demo');
    expect(output).toContain('graph_diff');
  });

  it('runs tool-backed steps for a suite', async () => {
    const repoDir = await createRepo();
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/core/demo-pack'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'ontoindex-packs/suites/demo-suite'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/core/demo-pack/pack.yml'),
      [
        'schema: 1',
        'id: demo.pack',
        'name: Demo Pack',
        'version: 0.1.0',
        'kind: query',
        'tier: stable',
        'summary: Demo pack.',
        'runs:',
        '  - tool: graph_diff',
        '    params:',
        '      limit: 5',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'ontoindex-packs/suites/demo-suite/suite.yml'),
      [
        'schema: 1',
        'id: suite.demo',
        'name: Demo Suite',
        'tier: stable',
        'summary: Demo suite.',
        'packs:',
        '  - demo.pack',
      ].join('\n'),
      'utf8',
    );
    callToolMock.mockResolvedValue({ status: 'success' });

    const { runPackCommand } = await import('../../src/cli/packs.js');
    await runPackCommand('suite.demo', { path: repoDir, repo: 'OntoIndex' });

    expect(callToolMock).toHaveBeenCalledWith('graph_diff', { limit: 5, repo: 'OntoIndex' });
    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('Ran suite suite.demo'));
  });
});
