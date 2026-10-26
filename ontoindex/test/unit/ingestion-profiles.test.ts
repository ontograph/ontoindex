import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureWorkspaceInputs } from '../../src/core/analyze-delta.js';
import { buildPhaseList, runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import * as phases from '../../src/core/ingestion/pipeline-phases/index.js';

describe('ingestion profiles', () => {
  it('parses captured sources and resolves captured aliases after live inputs change', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-captured-pipeline-'));
    let capture: Awaited<ReturnType<typeof captureWorkspaceInputs>> | undefined;
    try {
      await fs.mkdir(path.join(repoPath, 'src'));
      await fs.mkdir(path.join(repoPath, 'alternative'));
      const configPath = path.join(repoPath, 'tsconfig.json');
      await fs.writeFile(
        configPath,
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } } }),
      );
      await fs.writeFile(
        path.join(repoPath, 'src/caller.ts'),
        "import { capturedCallee } from '@app/callee';\nexport function caller() { return capturedCallee(); }\n",
      );
      await fs.writeFile(
        path.join(repoPath, 'src/callee.ts'),
        'export function capturedCallee() { return 1; }\n',
      );
      await fs.writeFile(
        path.join(repoPath, 'alternative/callee.ts'),
        'export function alternativeCallee() { return 2; }\n',
      );
      capture = await captureWorkspaceInputs(repoPath);

      await fs.writeFile(
        configPath,
        JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@app/*': ['alternative/*'] } },
        }),
      );
      await fs.writeFile(
        path.join(repoPath, 'src/callee.ts'),
        'export function liveCallee() { return 3; }\n',
      );

      const result = await runPipelineFromRepo(repoPath, () => {}, {
        profile: 'full',
        capturedWorkspace: capture,
        skipGraphPhases: true,
        skipWorkers: true,
      });
      expect(result.repoPath).toBe(await fs.realpath(repoPath));
      expect(result.graph.nodes).toContainEqual(
        expect.objectContaining({
          label: 'Function',
          properties: expect.objectContaining({
            name: 'capturedCallee',
            filePath: 'src/callee.ts',
          }),
        }),
      );
      expect(result.graph.nodes.some((node) => node.properties.name === 'liveCallee')).toBe(false);
      const imports = result.graph.relationships
        .filter((relationship) => relationship.type === 'IMPORTS')
        .map((relationship) => ({
          source: result.graph.getNode(relationship.sourceId)?.properties.filePath,
          target: result.graph.getNode(relationship.targetId)?.properties.filePath,
        }));
      expect(imports).toContainEqual({ source: 'src/caller.ts', target: 'src/callee.ts' });
      expect(imports).not.toContainEqual({
        source: 'src/caller.ts',
        target: 'alternative/callee.ts',
      });
      for (const node of result.graph.nodes) {
        const filePath = node.properties.filePath;
        if (typeof filePath === 'string') {
          expect(path.isAbsolute(filePath)).toBe(false);
          expect(filePath).not.toContain(capture.captureRoot);
        }
      }
    } finally {
      try {
        await capture?.dispose();
      } finally {
        await fs.rm(repoPath, { recursive: true, force: true });
      }
    }
  });

  it('runs captured inputs with canonical identity and no git mining', async () => {
    const capturedWorkspace = { captureRoot: '/capture', canonicalRepoPath: '/canonical' };
    const runner = vi.spyOn(phases, 'runPipeline').mockImplementation(async (selected, ctx) => {
      expect(ctx.repoPath).toBe(capturedWorkspace.captureRoot);
      expect(selected.map((phase) => phase.name)).not.toContain('gitMining');
      return new Map([
        [
          'parse',
          { phaseName: 'parse', output: { totalFiles: 1, usedWorkerPool: false }, durationMs: 0 },
        ],
      ]);
    });
    try {
      const result = await runPipelineFromRepo('/live', vi.fn(), {
        capturedWorkspace,
        skipGraphPhases: true,
      });
      expect(runner).toHaveBeenCalledOnce();
      expect(result.repoPath).toBe(capturedWorkspace.canonicalRepoPath);
    } finally {
      runner.mockRestore();
    }
  });

  it('full profile includes all standard phases including graph phases', () => {
    const phases = buildPhaseList({ profile: 'full' });
    const phaseNames = phases.map((p) => p.name);

    expect(phaseNames).toContain('scan');
    expect(phaseNames).toContain('parse');
    expect(phaseNames).toContain('crossFile');
    expect(phaseNames).toContain('communities');
    expect(phaseNames).toContain('processes');
  });

  it('symbols profile skips enrichment and graph phases', () => {
    const phases = buildPhaseList({ profile: 'symbols' });
    const phaseNames = phases.map((p) => p.name);

    expect(phaseNames).toEqual(['scan', 'structure', 'parse']);
  });

  it('huge-repo-symbols profile skips enrichment and graph phases', () => {
    const phases = buildPhaseList({ profile: 'huge-repo-symbols' });
    const phaseNames = phases.map((p) => p.name);

    expect(phaseNames).toEqual(['scan', 'structure', 'parse']);
  });

  it('skipGraphPhases option removes mro, communities, and processes', () => {
    const phases = buildPhaseList({ profile: 'full', skipGraphPhases: true });
    const phaseNames = phases.map((p) => p.name);

    expect(phaseNames).not.toContain('mro');
    expect(phaseNames).not.toContain('communities');
    expect(phaseNames).not.toContain('processes');
    expect(phaseNames).toContain('parse');
  });
});
