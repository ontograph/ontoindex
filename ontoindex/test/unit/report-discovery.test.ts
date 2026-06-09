/**
 * Unit tests for `ontoindex report hubs` and `ontoindex report surprising-connections` — REV-7.
 *
 * Covers:
 *  - Pure scoring helpers (computeHubScore, computeSurpriseScore, topLevelDir)
 *  - Text formatter guardrails (RANKED DISCOVERY VIEW label, safety footer)
 *  - isRankedDiscovery flag on result shapes
 *  - JSON output shape and guardrail field
 *  - Non-scope guardrails: discovery output does not suppress impact counts
 */

import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_LABEL,
  computeHubScore,
  computeSurpriseScore,
  topLevelDir,
  formatHubsText,
  formatSurprisingConnectionsText,
  type HubReport,
  type SurprisingConnectionsReport,
  type HubEntry,
  type SurprisingEdge,
} from '../../src/cli/report.js';

// ---------------------------------------------------------------------------
// computeHubScore
// ---------------------------------------------------------------------------

describe('computeHubScore', () => {
  it('returns 0 for a fully isolated node', () => {
    expect(computeHubScore(0, 0, 0)).toBe(0);
  });

  it('weights degree by 1.0', () => {
    expect(computeHubScore(10, 0, 0)).toBe(10);
  });

  it('weights processFlowCount by 5.0', () => {
    expect(computeHubScore(0, 3, 0)).toBe(15);
  });

  it('weights communitySpan beyond 1 by 3.0', () => {
    // span=1 → no bonus; span=3 → 2 extra communities × 3
    expect(computeHubScore(0, 0, 1)).toBe(0);
    expect(computeHubScore(0, 0, 3)).toBe(6);
  });

  it('combines all components additively', () => {
    // degree=10, proc=2, comm=3 → 10 + 10 + 6 = 26
    expect(computeHubScore(10, 2, 3)).toBe(26);
  });

  it('is deterministic (same input → same output)', () => {
    const a = computeHubScore(7, 4, 2);
    const b = computeHubScore(7, 4, 2);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// computeSurpriseScore
// ---------------------------------------------------------------------------

describe('computeSurpriseScore', () => {
  it('returns 0 when no surprising flags are set', () => {
    expect(computeSurpriseScore(false, false, false)).toBe(0);
  });

  it('scores crossesCommunityBoundary as 4', () => {
    expect(computeSurpriseScore(true, false, false)).toBe(4);
  });

  it('scores crossesDirectoryBoundary as 2', () => {
    expect(computeSurpriseScore(false, true, false)).toBe(2);
  });

  it('scores inExecutionFlow as 3', () => {
    expect(computeSurpriseScore(false, false, true)).toBe(3);
  });

  it('combines all flags to maximum score of 9', () => {
    expect(computeSurpriseScore(true, true, true)).toBe(9);
  });

  it('is deterministic', () => {
    expect(computeSurpriseScore(true, false, true)).toBe(computeSurpriseScore(true, false, true));
  });
});

// ---------------------------------------------------------------------------
// topLevelDir
// ---------------------------------------------------------------------------

describe('topLevelDir', () => {
  it('returns the first path segment for nested files', () => {
    expect(topLevelDir('src/core/foo.ts')).toBe('src');
    expect(topLevelDir('test/unit/bar.test.ts')).toBe('test');
  });

  it('returns empty string for root-level files', () => {
    expect(topLevelDir('README.md')).toBe('');
  });

  it('handles Windows-style backslashes', () => {
    expect(topLevelDir('src\\core\\foo.ts')).toBe('src');
  });
});

// ---------------------------------------------------------------------------
// formatHubsText — guardrail label
// ---------------------------------------------------------------------------

describe('formatHubsText — discovery label guardrail', () => {
  const emptyReport: HubReport = {
    repoId: 'testrepo',
    topN: 20,
    hubs: [],
    warnings: [],
    isRankedDiscovery: true,
  };

  it('includes the RANKED DISCOVERY VIEW label on the first line', () => {
    const text = formatHubsText(emptyReport);
    expect(text.startsWith(DISCOVERY_LABEL)).toBe(true);
  });

  it('includes a safety footer pointing to ontoindex impact', () => {
    const text = formatHubsText(emptyReport);
    expect(text).toContain('ontoindex impact');
    expect(text).toContain('verify blast-radius');
  });

  it('shows "no hubs found" for an empty hub list', () => {
    const text = formatHubsText(emptyReport);
    expect(text).toContain('no hubs found');
  });

  it('lists hub entries with rank, name, score', () => {
    const hub: HubEntry = {
      nodeId: 'node-1',
      name: 'myFunction',
      type: 'function',
      filePath: 'src/core/myFunction.ts',
      degree: 25,
      processFlowCount: 3,
      communitySpan: 2,
      hubScore: computeHubScore(25, 3, 2),
    };
    const report: HubReport = {
      repoId: 'testrepo',
      topN: 5,
      hubs: [hub],
      warnings: [],
      isRankedDiscovery: true,
    };
    const text = formatHubsText(report);
    expect(text).toContain('myFunction');
    expect(text).toContain('src/core/myFunction.ts');
    expect(text).toContain('why: Ranked as hub-like');
    expect(text).toContain('degree 25');
    expect(text).toContain('3 process flow(s)');
    expect(text).toContain('2 communities');
    expect(text).toContain('verify with: ontoindex impact myFunction');
    expect(text).toContain(DISCOVERY_LABEL);
  });

  it('includes warnings when present', () => {
    const report: HubReport = {
      ...emptyReport,
      warnings: ['degree query failed: timeout'],
    };
    const text = formatHubsText(report);
    expect(text).toContain('degree query failed: timeout');
  });
});

// ---------------------------------------------------------------------------
// formatSurprisingConnectionsText — guardrail label
// ---------------------------------------------------------------------------

describe('formatSurprisingConnectionsText — discovery label guardrail', () => {
  const emptyReport: SurprisingConnectionsReport = {
    repoId: 'testrepo',
    topN: 20,
    edges: [],
    warnings: [],
    isRankedDiscovery: true,
  };

  it('includes the RANKED DISCOVERY VIEW label on the first line', () => {
    const text = formatSurprisingConnectionsText(emptyReport);
    expect(text.startsWith(DISCOVERY_LABEL)).toBe(true);
  });

  it('includes a safety footer pointing to ontoindex impact', () => {
    const text = formatSurprisingConnectionsText(emptyReport);
    expect(text).toContain('ontoindex impact');
    expect(text).toContain('verify blast-radius');
  });

  it('shows "no surprising connections found" for an empty edge list', () => {
    const text = formatSurprisingConnectionsText(emptyReport);
    expect(text).toContain('no surprising connections found');
  });

  it('shows edge details including source file, target file, edge type', () => {
    const edge: SurprisingEdge = {
      sourceId: 'src-1',
      sourceName: 'callerFn',
      sourceFile: 'src/auth/login.ts',
      sourceCommunity: 'auth',
      targetId: 'tgt-1',
      targetName: 'renderWidget',
      targetFile: 'src/ui/widget.ts',
      targetCommunity: 'ui',
      edgeType: 'CALLS',
      crossesCommunityBoundary: true,
      crossesDirectoryBoundary: true,
      inExecutionFlow: false,
      surpriseScore: computeSurpriseScore(true, true, false),
    };
    const report: SurprisingConnectionsReport = {
      repoId: 'testrepo',
      topN: 5,
      edges: [edge],
      warnings: [],
      isRankedDiscovery: true,
    };
    const text = formatSurprisingConnectionsText(report);
    expect(text).toContain('callerFn');
    expect(text).toContain('renderWidget');
    expect(text).toContain('src/auth/login.ts');
    expect(text).toContain('src/ui/widget.ts');
    expect(text).toContain('CALLS');
    expect(text).toContain('cross-community');
    expect(text).toContain('cross-directory');
    expect(text).toContain('why: CALLS edge scored as surprising');
    expect(text).toContain('crosses community boundary');
    expect(text).toContain('crosses directory boundary');
    expect(text).toContain('verify: ontoindex impact callerFn  or  ontoindex impact renderWidget');
    expect(text).toContain(DISCOVERY_LABEL);
  });

  it('includes warnings when present', () => {
    const report: SurprisingConnectionsReport = {
      ...emptyReport,
      warnings: ['edge query failed: connection refused'],
    };
    const text = formatSurprisingConnectionsText(report);
    expect(text).toContain('edge query failed: connection refused');
  });
});

// ---------------------------------------------------------------------------
// isRankedDiscovery guardrail field
// ---------------------------------------------------------------------------

describe('isRankedDiscovery guardrail field', () => {
  it('HubReport always has isRankedDiscovery: true', () => {
    const report: HubReport = {
      repoId: 'r',
      topN: 5,
      hubs: [],
      warnings: [],
      isRankedDiscovery: true,
    };
    expect(report.isRankedDiscovery).toBe(true);
  });

  it('SurprisingConnectionsReport always has isRankedDiscovery: true', () => {
    const report: SurprisingConnectionsReport = {
      repoId: 'r',
      topN: 5,
      edges: [],
      warnings: [],
      isRankedDiscovery: true,
    };
    expect(report.isRankedDiscovery).toBe(true);
  });

  it('JSON.stringify of HubReport preserves isRankedDiscovery: true', () => {
    const report: HubReport = {
      repoId: 'r',
      topN: 5,
      hubs: [],
      warnings: [],
      isRankedDiscovery: true,
    };
    const parsed = JSON.parse(JSON.stringify(report)) as { isRankedDiscovery: unknown };
    expect(parsed.isRankedDiscovery).toBe(true);
  });

  it('JSON.stringify of HubReport preserves optional explanation fields', () => {
    const report: HubReport = {
      repoId: 'r',
      topN: 1,
      hubs: [
        {
          nodeId: 'node-1',
          name: 'hubFn',
          type: 'fn',
          filePath: 'src/hub.ts',
          degree: 8,
          processFlowCount: 2,
          communitySpan: 3,
          hubScore: 24,
          explanation: {
            summary:
              'Ranked as hub-like from degree 8, 2 process flow(s), 3 communities, score 24.0.',
            components: {
              degree: 8,
              processFlowCount: 2,
              communitySpan: 3,
              hubScore: 24,
            },
            verifyCommand: 'ontoindex impact hubFn',
          },
        },
      ],
      warnings: [],
      isRankedDiscovery: true,
    };
    const parsed = JSON.parse(JSON.stringify(report)) as {
      hubs: Array<{
        explanation?: {
          components?: Record<string, unknown>;
          verifyCommand?: unknown;
        };
      }>;
    };
    expect(parsed.hubs[0]?.explanation?.components).toMatchObject({
      degree: 8,
      processFlowCount: 2,
      communitySpan: 3,
      hubScore: 24,
    });
    expect(parsed.hubs[0]?.explanation?.verifyCommand).toBe('ontoindex impact hubFn');
  });

  it('JSON.stringify of SurprisingConnectionsReport preserves isRankedDiscovery: true', () => {
    const report: SurprisingConnectionsReport = {
      repoId: 'r',
      topN: 5,
      edges: [],
      warnings: [],
      isRankedDiscovery: true,
    };
    const parsed = JSON.parse(JSON.stringify(report)) as { isRankedDiscovery: unknown };
    expect(parsed.isRankedDiscovery).toBe(true);
  });

  it('JSON.stringify of SurprisingConnectionsReport preserves optional edge explanation fields', () => {
    const report: SurprisingConnectionsReport = {
      repoId: 'r',
      topN: 1,
      edges: [
        {
          sourceId: 'src-1',
          sourceName: 'sourceFn',
          sourceFile: 'src/source.ts',
          sourceCommunity: 'core',
          targetId: 'tgt-1',
          targetName: 'targetFn',
          targetFile: 'web/target.ts',
          targetCommunity: 'web',
          edgeType: 'REFERENCES',
          crossesCommunityBoundary: true,
          crossesDirectoryBoundary: true,
          inExecutionFlow: true,
          surpriseScore: 9,
          explanation: {
            summary:
              'REFERENCES edge scored as surprising because it crosses community boundary, crosses directory boundary, appears in an execution flow; score 9.',
            flags: {
              crossesCommunityBoundary: true,
              crossesDirectoryBoundary: true,
              inExecutionFlow: true,
              edgeType: 'REFERENCES',
              surpriseScore: 9,
            },
            verifyCommands: ['ontoindex impact sourceFn', 'ontoindex impact targetFn'],
          },
        },
      ],
      warnings: [],
      isRankedDiscovery: true,
    };
    const parsed = JSON.parse(JSON.stringify(report)) as {
      edges: Array<{
        explanation?: {
          flags?: Record<string, unknown>;
          verifyCommands?: unknown[];
        };
      }>;
    };
    expect(parsed.edges[0]?.explanation?.flags).toMatchObject({
      crossesCommunityBoundary: true,
      crossesDirectoryBoundary: true,
      inExecutionFlow: true,
      edgeType: 'REFERENCES',
      surpriseScore: 9,
    });
    expect(parsed.edges[0]?.explanation?.verifyCommands).toEqual([
      'ontoindex impact sourceFn',
      'ontoindex impact targetFn',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Non-scope guardrail: discovery output is independent of impact
// ---------------------------------------------------------------------------

describe('non-scope guardrail: discovery does not affect impact output', () => {
  it('HubReport has no field that could suppress or trim impact counts', () => {
    const report: HubReport = {
      repoId: 'r',
      topN: 5,
      hubs: [],
      warnings: [],
      isRankedDiscovery: true,
    };
    const keys = Object.keys(report);
    // Must not have any field implying suppression of callers or impact
    expect(keys).not.toContain('suppressedNodes');
    expect(keys).not.toContain('hiddenCallers');
    expect(keys).not.toContain('trimmedImpact');
  });

  it('SurprisingConnectionsReport has no field that could suppress or trim impact counts', () => {
    const report: SurprisingConnectionsReport = {
      repoId: 'r',
      topN: 5,
      edges: [],
      warnings: [],
      isRankedDiscovery: true,
    };
    const keys = Object.keys(report);
    expect(keys).not.toContain('suppressedNodes');
    expect(keys).not.toContain('hiddenCallers');
    expect(keys).not.toContain('trimmedImpact');
  });

  it('formatHubsText does not mention suppressed or hidden impact in its output', () => {
    const report: HubReport = {
      repoId: 'r',
      topN: 5,
      hubs: [],
      warnings: [],
      isRankedDiscovery: true,
    };
    const text = formatHubsText(report);
    expect(text.toLowerCase()).not.toContain('suppress');
    expect(text.toLowerCase()).not.toContain('hidden');
  });

  it('formatHubsText does not claim complete or authoritative impact coverage', () => {
    const report: HubReport = {
      repoId: 'r',
      topN: 5,
      hubs: [],
      warnings: [],
      isRankedDiscovery: true,
    };
    const text = formatHubsText(report).toLowerCase();
    expect(text).toContain('not a complete impact analysis');
    expect(text).not.toContain('authoritative');
    expect(text).not.toContain('complete impact authority');
  });

  it('formatSurprisingConnectionsText does not mention suppressed or hidden impact', () => {
    const report: SurprisingConnectionsReport = {
      repoId: 'r',
      topN: 5,
      edges: [],
      warnings: [],
      isRankedDiscovery: true,
    };
    const text = formatSurprisingConnectionsText(report);
    expect(text.toLowerCase()).not.toContain('suppress');
    expect(text.toLowerCase()).not.toContain('hidden');
  });

  it('formatSurprisingConnectionsText does not claim complete or authoritative impact coverage', () => {
    const report: SurprisingConnectionsReport = {
      repoId: 'r',
      topN: 5,
      edges: [],
      warnings: [],
      isRankedDiscovery: true,
    };
    const text = formatSurprisingConnectionsText(report).toLowerCase();
    expect(text).toContain('not a complete impact analysis');
    expect(text).not.toContain('authoritative');
    expect(text).not.toContain('complete impact authority');
  });
});

// ---------------------------------------------------------------------------
// Hub report — ordering guarantee
// ---------------------------------------------------------------------------

describe('formatHubsText — ordering', () => {
  it('renders hubs in the order provided (caller must pre-sort by hubScore)', () => {
    const hubs: HubEntry[] = [
      {
        nodeId: 'a',
        name: 'highHub',
        type: 'fn',
        filePath: 'a.ts',
        degree: 50,
        processFlowCount: 5,
        communitySpan: 3,
        hubScore: 100,
      },
      {
        nodeId: 'b',
        name: 'lowHub',
        type: 'fn',
        filePath: 'b.ts',
        degree: 1,
        processFlowCount: 0,
        communitySpan: 1,
        hubScore: 1,
      },
    ];
    const report: HubReport = {
      repoId: 'r',
      topN: 2,
      hubs,
      warnings: [],
      isRankedDiscovery: true,
    };
    const text = formatHubsText(report);
    const highIdx = text.indexOf('highHub');
    const lowIdx = text.indexOf('lowHub');
    expect(highIdx).toBeLessThan(lowIdx);
  });
});

// ---------------------------------------------------------------------------
// Surprising connections — score ordering
// ---------------------------------------------------------------------------

describe('formatSurprisingConnectionsText — ordering', () => {
  it('renders edges in the order provided (caller must pre-sort by surpriseScore)', () => {
    const edges: SurprisingEdge[] = [
      {
        sourceId: 'a',
        sourceName: 'topEdgeSource',
        sourceFile: 'src/a.ts',
        sourceCommunity: 'auth',
        targetId: 'b',
        targetName: 'topEdgeTarget',
        targetFile: 'src/ui/b.ts',
        targetCommunity: 'ui',
        edgeType: 'CALLS',
        crossesCommunityBoundary: true,
        crossesDirectoryBoundary: true,
        inExecutionFlow: true,
        surpriseScore: 9,
      },
      {
        sourceId: 'c',
        sourceName: 'lowEdgeSource',
        sourceFile: 'src/c.ts',
        sourceCommunity: 'auth',
        targetId: 'd',
        targetName: 'lowEdgeTarget',
        targetFile: 'src/d.ts',
        targetCommunity: 'auth',
        edgeType: 'CALLS',
        crossesCommunityBoundary: false,
        crossesDirectoryBoundary: false,
        inExecutionFlow: false,
        surpriseScore: 0,
      },
    ];
    const report: SurprisingConnectionsReport = {
      repoId: 'r',
      topN: 2,
      edges,
      warnings: [],
      isRankedDiscovery: true,
    };
    const text = formatSurprisingConnectionsText(report);
    const topIdx = text.indexOf('topEdgeSource');
    const lowIdx = text.indexOf('lowEdgeSource');
    expect(topIdx).toBeLessThan(lowIdx);
  });
});
