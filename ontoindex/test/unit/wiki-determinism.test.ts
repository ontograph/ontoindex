import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { WikiGenerator } from '../../src/core/wiki/generator.js';
import { generateHTMLViewer } from '../../src/core/wiki/html-viewer.js';
import { formatFileListForGrouping } from '../../src/core/wiki/prompts.js';

const llmConfig = {
  apiKey: '',
  baseUrl: '',
  model: 'test-model',
  maxTokens: 1_000,
  temperature: 0,
  provider: 'openai' as const,
};

function makeGenerator(): WikiGenerator {
  return new WikiGenerator(
    '/repo',
    '/repo/.ontoindex',
    '/repo/.ontoindex/lbug',
    llmConfig,
  );
}

describe('wiki determinism cleanup', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-determinism-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('sorts exported symbols in grouping prompts', () => {
    const output = formatFileListForGrouping([
      {
        filePath: 'src/foo.ts',
        symbols: [
          { name: 'zeta', type: 'Class' },
          { name: 'alpha', type: 'Function' },
        ],
      },
    ]);

    expect(output).toContain('- src/foo.ts: alpha (Function), zeta (Class)');
  });

  it('sorts module file paths before writing wiki metadata', () => {
    const generator = makeGenerator();
    const moduleFiles = (generator as any).extractModuleFiles([
      {
        name: 'Parent',
        slug: 'parent',
        files: [],
        children: [
          {
            name: 'Child B',
            slug: 'child-b',
            files: ['src/z.ts', 'src/a.ts'],
          },
          {
            name: 'Child A',
            slug: 'child-a',
            files: ['src/m.ts'],
          },
        ],
      },
    ]);

    expect(moduleFiles.Parent).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
    expect(moduleFiles['Child B']).toEqual(['src/a.ts', 'src/z.ts']);
    expect(moduleFiles['Child A']).toEqual(['src/m.ts']);
  });

  it('embeds markdown pages in sorted file order', async () => {
    await fs.writeFile(path.join(tmpDir, 'b.md'), 'B', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'a.md'), 'A', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'meta.json'), JSON.stringify({ generatedAt: '2026-06-17T00:00:00.000Z' }));
    await fs.writeFile(path.join(tmpDir, 'module_tree.json'), JSON.stringify([]));

    const outputPath = await generateHTMLViewer(tmpDir, 'Repo');
    const html = await fs.readFile(outputPath, 'utf-8');
    const pagesStart = html.indexOf('var PAGES = ');
    const aIndex = html.indexOf('"a":"A"', pagesStart);
    const bIndex = html.indexOf('"b":"B"', pagesStart);

    expect(aIndex).toBeGreaterThan(-1);
    expect(bIndex).toBeGreaterThan(-1);
    expect(aIndex).toBeLessThan(bIndex);
  });

  it('keeps generatedAt stable on a no-op incremental wiki update', async () => {
    const generator = makeGenerator();
    const saveWikiMeta = vi.fn().mockResolvedValue(undefined);

    (generator as any).getChangedFiles = vi.fn().mockReturnValue([]);
    (generator as any).saveWikiMeta = saveWikiMeta;

    const existingMeta = {
      fromCommit: 'abc1234',
      generatedAt: '2024-01-01T00:00:00.000Z',
      model: 'test-model',
      moduleFiles: {},
      moduleTree: [],
    };

    const result = await (generator as any).incrementalUpdate(existingMeta, 'def5678');

    expect(result).toEqual({
      pagesGenerated: 0,
      mode: 'incremental',
      failedModules: [],
    });
    expect(saveWikiMeta).toHaveBeenCalledTimes(1);
    expect(saveWikiMeta.mock.calls[0][0]).toMatchObject({
      fromCommit: 'def5678',
      generatedAt: existingMeta.generatedAt,
      model: 'test-model',
    });
  });
});
