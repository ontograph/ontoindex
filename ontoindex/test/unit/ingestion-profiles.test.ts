import { describe, expect, it, vi } from 'vitest';
import { buildPhaseList, runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import * as phases from '../../src/core/ingestion/pipeline-phases/index.js';

describe('ingestion profiles', () => {
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
