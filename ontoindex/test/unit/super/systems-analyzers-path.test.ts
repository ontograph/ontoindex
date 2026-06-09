import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, beforeEach, expect, it, vi } from 'vitest';

const { readRegistryMock } = vi.hoisted(() => ({
  readRegistryMock: vi.fn(),
}));

vi.mock('../../../src/storage/repo-manager.js', () => ({
  readRegistry: readRegistryMock,
}));

import { gnTaintTrace } from '../../../src/mcp/super/systems-analyzers.js';

describe('gn_taint_trace path resolution', () => {
  const repoName = 'codex';
  let repoPath: string;
  let outsidePath: string;

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), 'ontoindex-taint-trace-'));
    outsidePath = path.join('/', 'tmp', 'outside-main.rs');
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

  it('resolves repo-relative paths through repo name', async () => {
    const report = await gnTaintTrace(repoName, {
      path: 'codex-rs/cli/src/main.rs',
      source: 'args',
      sink: 'command_name_from_arg0',
    });

    expect(report.sidecarRecord.provenance.filePath).toBe('codex-rs/cli/src/main.rs');
    expect(report.paths).toHaveLength(1);
    expect(report.status).toBe('ok');
  });

  it('accepts an absolute path inside the repo for repo-relative mode', async () => {
    const report = await gnTaintTrace(repoName, {
      path: path.join(repoPath, 'codex-rs', 'cli', 'src', 'main.rs'),
      source: 'args',
      sink: 'command_name_from_arg0',
    });

    expect(report.sidecarRecord.provenance.filePath).toBe('codex-rs/cli/src/main.rs');
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
});
