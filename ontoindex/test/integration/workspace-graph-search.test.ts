import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';

type Hit = { name: string; filePath: string };
const hits = (result: unknown): Hit[] =>
  ((result as { definitions?: Hit[] }).definitions ?? []).map((d) => ({
    name: d.name,
    filePath: d.filePath,
  }));

describe('search on a workspace graph', () => {
  let root: string;
  let repo: string;
  let backend: LocalBackend;
  const search = (params: Record<string, unknown>) =>
    backend.callTool('query', { repo, ...params });

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-ws-search-'));
    repo = path.basename(root);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', root, ...args]);
    git('init', '-q');
    await fs.mkdir(path.join(root, 'src'));
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(root, '.gitignore'), '.ontoindex/\n');
    await fs.writeFile(
      path.join(root, 'src/exact.ts'),
      'export function pricingEngine() { return 1; }\n',
    );
    // Many earlier-sorting substring matches: an alphabetical scan would hide the exact target.
    for (let i = 0; i < 30; i++) {
      await fs.writeFile(
        path.join(root, `src/a${String(i).padStart(2, '0')}.ts`),
        `export function pricingHelper${i}() { return ${i}; }\n`,
      );
    }
    await fs.writeFile(
      path.join(root, 'src/gone.ts'),
      'export function pricingGone() { return 9; }\n',
    );
    await fs.writeFile(
      path.join(root, 'docs/notes.ts'),
      'export function pricingDocs() { return 2; }\n',
    );
    // More strong matches outside docs/ than the ranking window holds, and one weak match inside it.
    for (let i = 0; i < 70; i++) {
      await fs.writeFile(
        path.join(root, `src/shared${String(i).padStart(2, '0')}.ts`),
        'export function rankTermShared() { return rankTermShared; }\n',
      );
    }
    await fs.writeFile(
      path.join(root, 'docs/weak.ts'),
      "export function docsOnlyWeak() { return 'rankTermShared'; }\n",
    );
    git('add', '.');
    git('commit', '-qm', 'base');
    await runFullAnalysis(
      root,
      { skipNativeClose: true, skipAgentsMd: true, noStats: true },
      {
        onProgress() {},
      },
    );
    await fs.writeFile(
      path.join(root, 'src/fresh.ts'),
      'export function pricingFreshlyAdded() { return 3; }\n',
    );
    await fs.unlink(path.join(root, 'src/gone.ts'));
    await fs.writeFile(path.join(root, 'src/broken.ts'), 'export function pricingBroken( {\n');
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    backend = new LocalBackend();
    await backend.init();
    // No context/impact call first: the first search must prepare the workspace graph itself.
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await backend?.disconnect?.();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps an exact hit that sorts after many substring matches', async () => {
    expect(hits(await search({ query: 'pricingEngine' }))).toContainEqual({
      name: 'pricingEngine',
      filePath: 'src/exact.ts',
    });
  });

  it('finds a symbol that exists only in the working tree', async () => {
    expect(hits(await search({ query: 'pricingFreshlyAdded' }))).toContainEqual({
      name: 'pricingFreshlyAdded',
      filePath: 'src/fresh.ts',
    });
  });

  it('does not return a deleted file', async () => {
    expect(hits(await search({ query: 'pricingGone' }))).toEqual([]);
  });

  it('honours include_paths for a unique identifier', async () => {
    expect(hits(await search({ query: 'pricingDocs', include_paths: ['docs'] }))).toContainEqual({
      name: 'pricingDocs',
      filePath: 'docs/notes.ts',
    });
    expect(hits(await search({ query: 'pricingDocs', include_paths: ['src'] }))).toEqual([]);
  });

  it('finds a weak match inside the requested prefix despite many stronger matches outside it', async () => {
    const result = await search({ query: 'rankTermShared', include_paths: ['docs'] });
    expect(hits(result).map((hit) => hit.filePath)).toContain('docs/weak.ts');
  });

  it('excludes a prefix before ranking', async () => {
    const result = await search({ query: 'rankTermShared', exclude_paths: ['src'] });
    const paths = hits(result).map((hit) => hit.filePath);
    expect(paths).toContain('docs/weak.ts');
    expect(paths.some((p) => p.startsWith('src/'))).toBe(false);
  });

  it('reports that vector search is unavailable', async () => {
    const result = (await search({ query: 'pricingEngine' })) as { warning?: string };
    expect(result.warning).toContain('Vector search is unavailable');
  });

  it('ignores the symbol-neighborhood policy instead of reading base embeddings', async () => {
    const result = (await search({
      query: 'pricingEngine',
      retrieval_policy: 'symbol-neighborhood',
    })) as { warning?: string };
    expect(result.warning).toContain('symbol-neighborhood is unavailable');
    expect(hits(result)).toContainEqual({ name: 'pricingEngine', filePath: 'src/exact.ts' });
  });
});
