import path from 'node:path';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readRegistryMock } = vi.hoisted(() => ({ readRegistryMock: vi.fn() }));
vi.mock('../../../src/storage/repo-manager.js', () => ({ readRegistry: readRegistryMock }));

import { gnAuditLogic } from '../../../src/mcp/super/audit-logic.js';
import { dispatchSuper } from '../../../src/mcp/super/dispatch.js';
import { dispatchFacade } from '../../../src/mcp/facade/dispatch.js';

describe('gn_audit_logic source path', () => {
  let root: string;
  let selectedRepo: string;
  let cwdRepo: string;
  let outside: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'ontoindex-audit-logic-')));
    selectedRepo = path.join(root, 'selected');
    cwdRepo = path.join(root, 'cwd');
    outside = path.join(root, 'outside.c');
    await Promise.all([mkdir(selectedRepo), mkdir(cwdRepo)]);
    await writeFile(path.join(selectedRepo, 'source.c'), 'int selected(void) { open("x", 0); }');
    await writeFile(path.join(cwdRepo, 'source.c'), 'int cwd(void) { open("x", 0); }');
    await writeFile(outside, 'int outside(void) { return 1; }');
    readRegistryMock.mockResolvedValue([
      {
        name: 'cwd',
        path: cwdRepo,
        storagePath: path.join(cwdRepo, '.ontoindex'),
        indexedAt: '',
        lastCommit: '',
      },
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads repo-relative paths from the selected MCP repository root', async () => {
    const report = (await dispatchSuper('gn_audit_logic', { path: 'source.c' }, 'cwd', undefined, {
      repoPath: selectedRepo,
    })) as any;
    expect(report.systemsEvidence[0]?.snippet).toContain('selected');
    expect(report.systemsEvidence[0]?.snippet).not.toContain('cwd');
  });

  it('rejects traversal, absolute, and symlink paths outside the selected root', async () => {
    await symlink(outside, path.join(selectedRepo, 'escape.c'));
    for (const filePath of ['../outside.c', outside, 'escape.c']) {
      await expect(
        gnAuditLogic('cwd', { path: filePath }, { repoPath: selectedRepo }),
      ).rejects.toThrow(/Path escapes repository/);
    }
  });

  it('keeps an explicitly empty inline source from reading the path', async () => {
    const report = await gnAuditLogic(
      'cwd',
      { path: 'missing.c', source: '' },
      { repoPath: selectedRepo },
    );
    expect(report.warnings).toEqual([]);
    expect(report.skipReasons).toContain('no source or systems facts supplied');
  });

  it('threads the selected root through the public audit facade', async () => {
    const backend = {
      resolveRepo: async () => ({ id: 'cwd', name: 'cwd', repoPath: selectedRepo }),
    };
    const report = (await dispatchFacade(
      'audit',
      'logic',
      { path: 'source.c' },
      backend as any,
    )) as any;
    expect(report.systemsEvidence[0]?.snippet).toContain('selected');
  });

  it('supports direct root callers and marks missing path reads partial', async () => {
    const report = (await gnAuditLogic('cwd', { repo: selectedRepo, path: 'missing.c' })) as any;
    expect(report.status).toBe('partial');
    expect(report.warnings).toContainEqual(expect.stringContaining('could not read path'));
    const direct = (await gnAuditLogic(selectedRepo, { path: 'source.c' })) as any;
    expect(direct.systemsEvidence[0]?.snippet).toContain('selected');
  });
});
