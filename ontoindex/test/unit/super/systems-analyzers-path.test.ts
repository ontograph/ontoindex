import path from 'node:path';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, beforeEach, expect, it, vi } from 'vitest';

const { readRegistryMock } = vi.hoisted(() => ({
  readRegistryMock: vi.fn(),
}));

vi.mock('../../../src/storage/repo-manager.js', () => ({
  readRegistry: readRegistryMock,
}));

import { gnTaintTrace } from '../../../src/mcp/super/systems-analyzers.js';

describe('gn_taint_trace path resolution', () => {
  const repoName = 'codex';
  let fixtureRoot: string;
  let repoPath: string;
  let outsidePath: string;

  beforeEach(async () => {
    fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'ontoindex-taint-trace-')));
    repoPath = path.join(fixtureRoot, 'repo');
    outsidePath = path.join(fixtureRoot, 'outside', 'main.rs');
    readRegistryMock.mockClear();
    await mkdir(path.join(repoPath, 'codex-rs', 'cli', 'src'), { recursive: true });
    await writeFile(
      path.join(repoPath, 'codex-rs', 'cli', 'src', 'main.rs'),
      'const args = ["command", "x"];\\nconst command = command_name_from_arg0(args);',
      'utf8',
    );

    readRegistryMock.mockResolvedValue([
      {
        name: repoName,
        path: repoPath,
        storagePath: path.join(repoPath, '.ontoindex'),
        indexedAt: '2026-01-01T00:00:00Z',
        lastCommit: '000000000000000000000000000000000000000000',
      },
    ]);
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('resolves repo-relative paths through repo name', async () => {
    const report = await gnTaintTrace(repoName, {
      path: 'codex-rs/cli/src/main.rs',
      source: 'args',
      sink: 'command_name_from_arg0',
    });

    expect(report.sidecarRecord).toMatchObject({
      provenance: { filePath: 'codex-rs/cli/src/main.rs' },
    });
    expect(report.paths).toHaveLength(1);
    expect(report.status).toBe('ok');
  });

  it('accepts an absolute path inside the repo for repo-relative mode', async () => {
    const report = await gnTaintTrace(repoName, {
      path: path.join(repoPath, 'codex-rs', 'cli', 'src', 'main.rs'),
      source: 'args',
      sink: 'command_name_from_arg0',
    });

    expect(report.sidecarRecord).toMatchObject({
      provenance: { filePath: 'codex-rs/cli/src/main.rs' },
    });
    expect(report.paths).toHaveLength(1);
  });

  it('rejects traversal paths that escape the repo root', async () => {
    await expect(
      gnTaintTrace(repoName, {
        path: '../outside/main.rs',
        source: 'args',
        sink: 'command_name_from_arg0',
      }),
    ).rejects.toThrow(
      `Path is outside repository: ../outside/main.rs. Use a path under ${repoPath}.`,
    );
  });

  it('rejects absolute paths that escape the repo root', async () => {
    await expect(
      gnTaintTrace(repoName, {
        path: outsidePath,
        source: 'args',
        sink: 'command_name_from_arg0',
      }),
    ).rejects.toThrow(`Path is outside repository: ${outsidePath}. Use a path under ${repoPath}.`);
  });

  it.each(['external.rs', 'external/main.rs', 'external/missing.rs'])(
    'rejects symlink escape through %s',
    async (inputPath) => {
      await mkdir(path.dirname(outsidePath));
      await writeFile(outsidePath, 'const value = args;\ncommand_name_from_arg0(value);');
      await symlink(outsidePath, path.join(repoPath, 'external.rs'));
      await symlink(path.dirname(outsidePath), path.join(repoPath, 'external'), 'dir');

      await expect(
        gnTaintTrace(repoName, { path: inputPath, source: 'args', sink: 'command_name_from_arg0' }),
      ).rejects.toThrow(`Path is outside repository: ${inputPath}. Use a path under ${repoPath}.`);
    },
  );

  it('accepts a filename beginning with two dots', async () => {
    await writeFile(
      path.join(repoPath, '..valid.ts'),
      'const args = ["command", "x"];\nconst command = command_name_from_arg0(args);',
    );

    const report = await gnTaintTrace(repoName, {
      path: '..valid.ts',
      source: 'args',
      sink: 'command_name_from_arg0',
    });

    expect(report.sidecarRecord).toMatchObject({ provenance: { filePath: '..valid.ts' } });
    expect(report.paths).toHaveLength(1);
    expect(report.warnings).toEqual([]);
  });

  it.each(['alias.rs', 'alias-dir/main.rs'])(
    'accepts an internal symlink through %s with canonical provenance',
    async (inputPath) => {
      const sourceDir = path.join(repoPath, 'codex-rs', 'cli', 'src');
      await symlink(path.join(sourceDir, 'main.rs'), path.join(repoPath, 'alias.rs'));
      await symlink(sourceDir, path.join(repoPath, 'alias-dir'), 'dir');

      const report = await gnTaintTrace(repoName, {
        path: inputPath,
        source: 'args',
        sink: 'command_name_from_arg0',
      });

      expect(report.sidecarRecord).toMatchObject({
        provenance: { filePath: 'codex-rs/cli/src/main.rs' },
      });
      expect(report.paths).toHaveLength(1);
      expect(report.warnings).toEqual([]);
    },
  );

  it.each(['relative', 'canonical-absolute', 'alias-absolute'])(
    'resolves %s input under a symlinked repository root',
    async (inputKind) => {
      const aliasRoot = path.join(fixtureRoot, 'repo-alias');
      await symlink(repoPath, aliasRoot, 'dir');
      readRegistryMock.mockResolvedValue([{ name: repoName, path: aliasRoot }]);
      const relativePath = 'codex-rs/cli/src/main.rs';
      const inputPath =
        inputKind === 'relative'
          ? relativePath
          : path.join(inputKind === 'canonical-absolute' ? repoPath : aliasRoot, relativePath);

      const report = await gnTaintTrace(repoName, {
        path: inputPath,
        source: 'args',
        sink: 'command_name_from_arg0',
      });

      expect(report.sidecarRecord).toMatchObject({ provenance: { filePath: relativePath } });
      expect(report.paths).toHaveLength(1);
      expect(report.warnings).toEqual([]);
    },
  );

  it('preserves read warnings for an ordinary missing in-repo file', async () => {
    const report = await gnTaintTrace(repoName, {
      path: 'missing.rs',
      source: 'args',
      sink: 'command_name_from_arg0',
    });

    expect(report.sidecarRecord).toMatchObject({ provenance: { filePath: 'missing.rs' } });
    expect(report.paths).toEqual([]);
    expect(report.warnings).toContainEqual(
      expect.stringContaining(`could not read path missing.rs from repo ${repoPath}:`),
    );
  });

  it('preserves the resolution error for a dangling symlink', async () => {
    await symlink(path.join(repoPath, 'missing.rs'), path.join(repoPath, 'dangling.rs'));

    await expect(
      gnTaintTrace(repoName, {
        path: 'dangling.rs',
        source: 'args',
        sink: 'command_name_from_arg0',
      }),
    ).rejects.toThrow('Unable to resolve path: dangling.rs');
  });
});
