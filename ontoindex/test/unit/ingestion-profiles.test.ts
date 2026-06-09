import { describe, expect, it } from 'vitest';
import { buildPhaseList } from '../../src/core/ingestion/pipeline.js';

describe('ingestion profiles', () => {
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
