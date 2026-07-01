import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import type { PathLike } from 'node:fs';
import path from 'node:path';
import { exportGraphHtmlCommand } from '../../src/cli/export.js';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';
import { buildExportableGraph } from '../../src/core/graph/exportable-graph.js';
import { generateHTMLViewer } from '../../src/core/wiki/html-viewer.js';

vi.mock('node:fs');
vi.mock('../../src/storage/repo-manager.js');
vi.mock('../../src/core/graph/exportable-graph.js');
vi.mock('../../src/core/wiki/html-viewer.js');
vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(),
  closeLbug: vi.fn(),
  executeQuery: vi.fn(),
}));

describe('exportGraphHtmlCommand', () => {
  const repoRoot = path.resolve('/repo');
  const exportsDir = path.join(repoRoot, '.ontoindex', 'exports');
  const wikiDir = path.join(repoRoot, '.ontoindex', 'wiki');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStoragePaths).mockReturnValue({
      storagePath: path.join(repoRoot, '.ontoindex'),
      lbugPath: path.join(repoRoot, '.ontoindex', 'lbug.db'),
    } as any);
    vi.mocked(loadMeta).mockResolvedValue({
      indexedAt: '2026-06-13T00:00:00.000Z',
      lastCommit: 'abc1234',
    } as any);
    vi.mocked(buildExportableGraph).mockResolvedValue({
      nodes: [],
      relationships: [],
    });
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('writes graph-overview.html to the exports directory', async () => {
    await exportGraphHtmlCommand({ repo: '/repo', out: '/repo/.ontoindex/exports' });

    expect(buildExportableGraph).toHaveBeenCalled();
    expect(fs.mkdirSync).toHaveBeenCalledWith(exportsDir, { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(exportsDir, 'graph-overview.html'),
      expect.stringContaining(
        'Interactive architecture graph for modules, execution flows, and functional areas.',
      ),
      'utf8',
    );
    expect(generateHTMLViewer).not.toHaveBeenCalled();
  });

  it('refreshes the wiki viewer when exporting into a wiki directory', async () => {
    vi.mocked(fs.existsSync).mockImplementation((filePath: PathLike) => {
      const normalized = path.normalize(String(filePath));
      return (
        normalized.endsWith(path.join('wiki', 'module_tree.json')) ||
        normalized.endsWith(path.join('wiki', 'meta.json'))
      );
    });

    await exportGraphHtmlCommand({ repo: '/repo', out: '/repo/.ontoindex/wiki', summary: true });

    expect(generateHTMLViewer).toHaveBeenCalledWith(wikiDir, 'repo');
  });
});
