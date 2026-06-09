import { afterEach, describe, expect, it } from 'vitest';
import { gnToolContract } from '../../../src/mcp/super/tool-contract.js';
import { getPublicToolRegistry } from '../../../src/mcp/shared/tool-registry.js';

const ORIGINAL_STARTUP_PROFILE = process.env.ONTOINDEX_MCP_STARTUP_PROFILE;

afterEach(() => {
  if (ORIGINAL_STARTUP_PROFILE === undefined) {
    delete process.env.ONTOINDEX_MCP_STARTUP_PROFILE;
  } else {
    process.env.ONTOINDEX_MCP_STARTUP_PROFILE = ORIGINAL_STARTUP_PROFILE;
  }
});

describe('gnToolContract — ADR26 classification metadata', () => {
  it('emits classification inventory for every selected registry entry', () => {
    const report = gnToolContract({ includeFacades: true });
    const registry = getPublicToolRegistry({ includeFacades: true });

    expect(report.classificationInventory).toHaveLength(registry.length);
    expect(report.classificationInventory.every((entry) => entry.workflowIntents.length > 0)).toBe(
      true,
    );
    expect(
      report.classificationInventory.every((entry) => entry.producesEvidenceClasses.length > 0),
    ).toBe(true);
  });

  it('emits deterministic classification summary counts', () => {
    const report = gnToolContract({ includeFacades: true });
    const summary = report.classificationReport;

    expect(summary.totalTools).toBe(report.classificationInventory.length);
    expect(summary.nonAuthoritativeEvidenceClasses).toEqual([
      'advisory_memory',
      'runtime_diagnostic',
    ]);

    const stabilityTotal = Object.values(summary.byStability).reduce((sum, n) => sum + n, 0);
    expect(stabilityTotal).toBe(summary.totalTools);
  });

  it('includes runtime source identity so stale MCP sessions are visible', () => {
    const report = gnToolContract({ includeFacades: true });

    expect(report.runtime.sourceIdentity).toMatchObject({
      moduleUrl: expect.stringContaining('/mcp/super/tool-contract.'),
      processId: process.pid,
      nodeVersion: process.version,
    });
    expect(Date.parse(report.runtime.sourceIdentity.processStartTime)).not.toBeNaN();
  });

  it('keeps advisory/diagnostic classes non-authoritative by default', () => {
    const report = gnToolContract({ includeFacades: true });
    const nonAuthoritative = report.classificationInventory.filter((entry) =>
      entry.producesEvidenceClasses.some(
        (evidenceClass) =>
          evidenceClass === 'advisory_memory' || evidenceClass === 'runtime_diagnostic',
      ),
    );

    expect(nonAuthoritative.length).toBeGreaterThan(0);
    expect(nonAuthoritative.every((entry) => entry.auditAuthority === false)).toBe(true);
  });

  it('declares ADR28 evidence source metadata for every public evidence-producing entry', () => {
    const registry = getPublicToolRegistry({ includeFacades: true });
    const evidenceProducingEntries = registry.filter((entry) =>
      entry.producesEvidenceClasses.some((evidenceClass) => evidenceClass !== 'unknown'),
    );

    expect(evidenceProducingEntries.length).toBeGreaterThan(0);
    for (const entry of evidenceProducingEntries) {
      expect(entry.evidenceSources.map((source) => source.evidenceClass)).toEqual(
        [...entry.producesEvidenceClasses].sort(),
      );
      expect(entry.evidenceSources.every((source) => source.freshnessBehavior.length > 0)).toBe(
        true,
      );
      expect(entry.evidenceSources.every((source) => source.provenanceFields.length > 0)).toBe(
        true,
      );
      expect(entry.evidenceSources.every((source) => source.truncationPolicy.length > 0)).toBe(
        true,
      );
      expect(entry.evidenceSources.every((source) => source.responsePolicy.length > 0)).toBe(true);
    }

    const advisorySources = evidenceProducingEntries.flatMap((entry) =>
      entry.evidenceSources.filter(
        (source) =>
          source.evidenceClass === 'advisory_memory' ||
          source.evidenceClass === 'runtime_diagnostic',
      ),
    );
    expect(advisorySources.length).toBeGreaterThan(0);
    expect(
      advisorySources.every(
        (source) =>
          source.advisoryOnly === true &&
          source.auditAuthority === false &&
          source.safeForBasedOnReads === false,
      ),
    ).toBe(true);
  });
});

describe('gnToolContract — ADR27 startup-profile metadata', () => {
  it('reports default public-full compatibility without hidden callable tools', () => {
    delete process.env.ONTOINDEX_MCP_STARTUP_PROFILE;
    const report = gnToolContract({ includeFacades: true });
    const fullPublicCount = getPublicToolRegistry({ includeFacades: true }).length;

    expect(report.startupProfile).toMatchObject({
      activeProfile: 'public-full',
      source: 'default',
      advertisedCount: fullPublicCount,
      hiddenButCallableCount: 0,
      fullPublicCount,
      facadesIncluded: true,
      enforcementMode: 'advertise_only',
      compatibilityMode: false,
    });
    expect(report.startupProfile.advertised).toEqual(report.callable);
  });

  it('reports hidden-but-callable names and counts for advertise-only profiles', () => {
    process.env.ONTOINDEX_MCP_STARTUP_PROFILE = 'core';
    const report = gnToolContract({ includeFacades: true });

    expect(report.startupProfile.activeProfile).toBe('core');
    expect(report.startupProfile.hiddenButCallable).toContain('gn_audit_ingest');
    expect(report.startupProfile.hiddenButCallable).toContain('gn_safe_refactor');
    expect(report.startupProfile.hiddenButCallableCount).toBe(
      report.startupProfile.hiddenButCallable.length,
    );
    expect(report.startupProfile.hiddenButCallableCount).toBeGreaterThan(0);
    expect(report.startupProfile.enforcementMode).toBe('advertise_only');
  });

  it('keeps public-full explicit env selection compatible with the full public frontier', () => {
    process.env.ONTOINDEX_MCP_STARTUP_PROFILE = 'public-full';
    const report = gnToolContract({ includeFacades: true });

    expect(report.startupProfile.source).toBe('env');
    expect(report.startupProfile.activeProfile).toBe('public-full');
    expect(report.startupProfile.advertisedCount).toBe(report.startupProfile.fullPublicCount);
    expect(report.startupProfile.hiddenButCallableCount).toBe(0);
  });
});

describe('gnToolContract — visible frontier', () => {
  it('includes an explicit internal vs host-visible frontier summary with caveat text', () => {
    const report = gnToolContract({ includeFacades: true });

    expect(report.visibleFrontier).toMatchObject({
      mode: 'default',
      activeStartupProfile: 'public-full',
      hostVisible: expect.any(Array),
      clientVisible: expect.any(Array),
      internalCallable: expect.any(Array),
      internalOnly: expect.any(Array),
      clientOnly: expect.any(Array),
      note: expect.stringContaining('Callable tools in the OntoIndex registry'),
    });
    for (const tool of report.visibleFrontier.hostVisible) {
      expect(report.visibleFrontier.internalCallable).toContain(tool);
    }
    for (const tool of report.visibleFrontier.internalOnly) {
      expect(report.visibleFrontier.internalCallable).toContain(tool);
      expect(report.visibleFrontier.hostVisible).not.toContain(tool);
    }
  });

  it('marks host-hidden internal callable tools when startup profile is reduced', () => {
    process.env.ONTOINDEX_MCP_STARTUP_PROFILE = 'core';
    const report = gnToolContract({ includeFacades: true });

    expect(report.visibleFrontier.activeStartupProfile).toBe('core');
    expect(report.visibleFrontier.mode).toBe('default');
    expect(report.visibleFrontier.internalOnly.length).toBeGreaterThan(0);
    for (const tool of report.visibleFrontier.internalOnly) {
      expect(report.visibleFrontier.hostVisible).not.toContain(tool);
      expect(report.visibleFrontier.internalCallable).toContain(tool);
    }
    expect(new Set(report.visibleFrontier.internalOnly)).toEqual(
      new Set(report.startupProfile.hiddenButCallable),
    );
  });
});
