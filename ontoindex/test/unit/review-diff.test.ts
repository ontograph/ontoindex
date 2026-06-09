/**
 * Unit tests for the `review diff` CLI command (REV-2 + REV-3 + REV-4).
 *
 * Covers the pure helper functions and the JSON envelope structure.
 * Does not require a live git repo or LadybugDB.
 *
 * REV-3 additions: acceptance-gate tests for fresh, stale, dirty-worktree,
 * missing-index, staged, branch-range, partial-sidecar, and compatibility cases.
 *
 * REV-4 additions: help/docs contract tests — local-only messaging, no implied
 * hosted-PR support, stale-index and analyze-suggestion are present, JSON-mode
 * label is machine-readable, Phase 6 deferral note is present.
 */

import { describe, expect, it } from 'vitest';
import {
  buildReviewDiffArgs,
  parseReviewNumstat,
  formatReviewDiffText,
} from '../../src/cli/review.js';
import type { DiffReviewResult } from '../../src/core/review/review-types.js';

// ---------------------------------------------------------------------------
// buildReviewDiffArgs
// ---------------------------------------------------------------------------

describe('buildReviewDiffArgs', () => {
  it('uses --cached when no options given', () => {
    const result = buildReviewDiffArgs({});
    expect(result.resolvedRange).toBe('--cached');
    expect(result.nameOnly).toEqual(['diff', '--cached', '--name-only']);
    expect(result.numstat).toEqual(['diff', '--cached', '--numstat']);
  });

  it('uses --cached when --staged is explicitly set', () => {
    const result = buildReviewDiffArgs({ staged: true });
    expect(result.resolvedRange).toBe('--cached');
  });

  it('uses explicit --range verbatim', () => {
    const result = buildReviewDiffArgs({ range: 'main...feature' });
    expect(result.resolvedRange).toBe('main...feature');
    expect(result.nameOnly).toEqual(['diff', 'main...feature', '--name-only']);
    expect(result.numstat).toEqual(['diff', 'main...feature', '--numstat']);
  });

  it('builds range from --base alone (HEAD default)', () => {
    const result = buildReviewDiffArgs({ base: 'main' });
    expect(result.resolvedRange).toBe('main..HEAD');
    expect(result.nameOnly).toEqual(['diff', 'main..HEAD', '--name-only']);
  });

  it('builds range from --base and --head', () => {
    const result = buildReviewDiffArgs({ base: 'main', head: 'feature' });
    expect(result.resolvedRange).toBe('main..feature');
    expect(result.nameOnly).toEqual(['diff', 'main..feature', '--name-only']);
  });

  it('--range takes precedence over --base/--head', () => {
    const result = buildReviewDiffArgs({ range: 'v1..v2', base: 'main', head: 'feature' });
    expect(result.resolvedRange).toBe('v1..v2');
  });
});

// ---------------------------------------------------------------------------
// parseReviewNumstat
// ---------------------------------------------------------------------------

describe('parseReviewNumstat', () => {
  it('parses standard numstat output', () => {
    const output = '10\t3\tsrc/foo.ts\n5\t0\tsrc/bar.ts\n';
    const result = parseReviewNumstat(output);
    expect(result.get('src/foo.ts')).toEqual({ added: 10, removed: 3 });
    expect(result.get('src/bar.ts')).toEqual({ added: 5, removed: 0 });
  });

  it('handles binary files (- counts)', () => {
    const output = '-\t-\tassets/logo.png\n';
    const result = parseReviewNumstat(output);
    // '-' parses to 0
    expect(result.get('assets/logo.png')).toEqual({ added: 0, removed: 0 });
  });

  it('handles empty output', () => {
    expect(parseReviewNumstat('')).toEqual(new Map());
  });

  it('handles paths containing tabs (edge case)', () => {
    const output = '1\t2\tpath\twith\ttabs.ts\n';
    const result = parseReviewNumstat(output);
    expect(result.has('path\twith\ttabs.ts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatReviewDiffText
// ---------------------------------------------------------------------------

describe('formatReviewDiffText', () => {
  const emptyResult: DiffReviewResult = {
    reviewedFiles: [],
    totalSymbolsChanged: 0,
    highRiskSymbols: [],
    warnings: [],
  };

  it('includes range and freshness on first lines', () => {
    const text = formatReviewDiffText(
      'main..HEAD',
      emptyResult,
      'fresh',
      'target context aligned',
      [],
    );
    expect(text).toContain('review diff: main..HEAD');
    expect(text).toContain('freshness: fresh');
    expect(text).toContain('target context aligned');
  });

  it('shows zero files/symbols for empty diff', () => {
    const text = formatReviewDiffText('--cached', emptyResult, 'fresh', 'ok', []);
    expect(text).toContain('files: 0  symbols: 0');
  });

  it('lists high-risk symbols', () => {
    const result: DiffReviewResult = {
      ...emptyResult,
      highRiskSymbols: ['buildDiffReview', 'gnDiffImpact'],
    };
    const text = formatReviewDiffText('main..HEAD', result, 'fresh', 'ok', []);
    expect(text).toContain('high-risk: buildDiffReview, gnDiffImpact');
  });

  it('formats per-file symbol entries', () => {
    const result: DiffReviewResult = {
      reviewedFiles: [
        {
          path: 'src/foo.ts',
          addedLines: 10,
          removedLines: 3,
          changedSymbols: [
            {
              nodeId: 'n1',
              name: 'fooFunc',
              impact: { upstreamCount: 12, downstreamCount: 2, risk: 'MEDIUM', heuristic: false },
            },
          ],
        },
      ],
      totalSymbolsChanged: 1,
      highRiskSymbols: [],
      warnings: [],
    };
    const text = formatReviewDiffText('main..HEAD', result, 'fresh', 'ok', []);
    expect(text).toContain('src/foo.ts (+10 -3)');
    expect(text).toContain('[MEDIUM] fooFunc');
    expect(text).toContain('↑12 callers');
    expect(text).toContain('↓2 deps');
  });

  it('marks heuristic counts with tilde', () => {
    const result: DiffReviewResult = {
      reviewedFiles: [
        {
          path: 'src/bar.ts',
          addedLines: 1,
          removedLines: 0,
          changedSymbols: [
            {
              nodeId: 'n2',
              name: 'barFunc',
              impact: { upstreamCount: 5, downstreamCount: 1, risk: 'LOW', heuristic: true },
            },
          ],
        },
      ],
      totalSymbolsChanged: 1,
      highRiskSymbols: [],
      warnings: [],
    };
    const text = formatReviewDiffText('--cached', result, 'degraded', 'dirty-worktree-overlay', []);
    expect(text).toContain('↑~5 callers');
  });

  it('appends warnings section when warnings present', () => {
    const text = formatReviewDiffText(
      '--cached',
      emptyResult,
      'stale',
      'indexedHead != targetHead',
      ['no OntoIndex index found; symbol analysis unavailable'],
    );
    expect(text).toContain('warnings:');
    expect(text).toContain('• no OntoIndex index found');
  });

  it('omits warnings section when warnings empty', () => {
    const text = formatReviewDiffText('--cached', emptyResult, 'fresh', 'ok', []);
    expect(text).not.toContain('warnings:');
  });

  it('shows stale freshness status honestly', () => {
    const text = formatReviewDiffText(
      'main..HEAD',
      emptyResult,
      'stale',
      'indexedHead != targetHead',
      [],
    );
    expect(text).toContain('freshness: stale');
    expect(text).toContain('indexedHead != targetHead');
  });
});

// ---------------------------------------------------------------------------
// REV-3: Acceptance-gate tests
// ---------------------------------------------------------------------------

// Helpers shared across acceptance tests
const emptyResultForAcceptance: DiffReviewResult = {
  reviewedFiles: [],
  totalSymbolsChanged: 0,
  highRiskSymbols: [],
  warnings: [],
};

const fileWithSymbol = (
  path: string,
  symbolName: string,
  risk: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW',
): DiffReviewResult['reviewedFiles'][0] => ({
  path,
  addedLines: 5,
  removedLines: 2,
  changedSymbols: [
    {
      nodeId: `node-${symbolName}`,
      name: symbolName,
      impact: {
        upstreamCount: risk === 'HIGH' ? 60 : risk === 'MEDIUM' ? 15 : 3,
        downstreamCount: 1,
        risk,
        heuristic: false,
      },
    },
  ],
});

// ---- fresh ----------------------------------------------------------------

describe('REV-3 acceptance: fresh', () => {
  it('shows fresh freshness status with processes and communities', () => {
    const result: DiffReviewResult = {
      ...emptyResultForAcceptance,
      reviewedFiles: [fileWithSymbol('src/core.ts', 'buildFoo')],
      totalSymbolsChanged: 1,
      affectedProcesses: [
        { id: 'p1', name: 'Build Pipeline', processType: 'pipeline', changedStepCount: 2 },
      ],
      affectedCommunities: [{ id: 'c1', name: 'Core', changedSymbolCount: 1 }],
      crossCommunityRiskReasons: [],
      graphSections: { processesAvailable: true, communitiesAvailable: true },
    };
    const text = formatReviewDiffText(
      'main..HEAD',
      result,
      'fresh',
      'indexedHead == targetHead',
      [],
    );
    expect(text).toContain('freshness: fresh');
    expect(text).toContain('processes (1)');
    expect(text).toContain('Build Pipeline [pipeline]');
    expect(text).toContain('communities (1)');
    expect(text).toContain('Core');
  });

  it('does not emit processes/communities sections when both are empty and available', () => {
    const result: DiffReviewResult = {
      ...emptyResultForAcceptance,
      affectedProcesses: [],
      affectedCommunities: [],
      graphSections: { processesAvailable: true, communitiesAvailable: true },
    };
    const text = formatReviewDiffText('main..HEAD', result, 'fresh', 'ok', []);
    expect(text).not.toContain('processes');
    expect(text).not.toContain('communities');
  });
});

// ---- stale ----------------------------------------------------------------

describe('REV-3 acceptance: stale', () => {
  it('reports stale freshness and still emits graph sections if available', () => {
    const result: DiffReviewResult = {
      ...emptyResultForAcceptance,
      reviewedFiles: [fileWithSymbol('src/api.ts', 'handleRequest')],
      totalSymbolsChanged: 1,
      affectedProcesses: [
        { id: 'p2', name: 'HTTP Flow', processType: 'request', changedStepCount: 1 },
      ],
      affectedCommunities: [],
      graphSections: { processesAvailable: true, communitiesAvailable: true },
    };
    const text = formatReviewDiffText(
      'main..HEAD',
      result,
      'stale',
      'indexedHead != targetHead',
      [],
    );
    expect(text).toContain('freshness: stale');
    expect(text).toContain('indexedHead != targetHead');
    expect(text).toContain('processes (1)');
    expect(text).toContain('HTTP Flow');
  });

  it('stale graph still shows complete impact counts', () => {
    const result: DiffReviewResult = {
      ...emptyResultForAcceptance,
      reviewedFiles: [fileWithSymbol('src/utils.ts', 'utilFn', 'HIGH')],
      totalSymbolsChanged: 1,
      highRiskSymbols: ['utilFn'],
    };
    const text = formatReviewDiffText('main..HEAD', result, 'stale', 'stale reason', []);
    // Impact counts not trimmed
    expect(text).toContain('[HIGH] utilFn');
    expect(text).toContain('↑60 callers');
  });
});

// ---- dirty-worktree -------------------------------------------------------

describe('REV-3 acceptance: dirty-worktree', () => {
  it('reports degraded status for dirty-worktree overlay', () => {
    const text = formatReviewDiffText(
      '--cached',
      emptyResultForAcceptance,
      'degraded',
      'dirty-worktree-overlay',
      ['dirty worktree: graph counts may not match current state'],
    );
    expect(text).toContain('freshness: degraded');
    expect(text).toContain('dirty-worktree-overlay');
    expect(text).toContain('warnings:');
    expect(text).toContain('dirty worktree');
  });

  it('still shows heuristic impact for dirty-worktree', () => {
    const result: DiffReviewResult = {
      ...emptyResultForAcceptance,
      reviewedFiles: [
        {
          path: 'src/mod.ts',
          addedLines: 1,
          removedLines: 0,
          changedSymbols: [
            {
              nodeId: 'n3',
              name: 'dirtyFn',
              impact: { upstreamCount: 8, downstreamCount: 0, risk: 'LOW', heuristic: true },
            },
          ],
        },
      ],
      totalSymbolsChanged: 1,
    };
    const text = formatReviewDiffText('--cached', result, 'degraded', 'dirty-worktree', []);
    expect(text).toContain('↑~8 callers');
  });
});

// ---- missing-index --------------------------------------------------------

describe('REV-3 acceptance: missing-index', () => {
  it('reports no OntoIndex index warning and omits symbol analysis', () => {
    const result: DiffReviewResult = {
      reviewedFiles: [{ path: 'src/foo.ts', addedLines: 3, removedLines: 1, changedSymbols: [] }],
      totalSymbolsChanged: 0,
      highRiskSymbols: [],
      warnings: [
        'no OntoIndex index found; symbol analysis unavailable — run `ontoindex analyze` first',
      ],
    };
    const text = formatReviewDiffText('--cached', result, 'stale', 'no index', result.warnings);
    expect(text).toContain('no OntoIndex index found');
    expect(text).toContain('files: 1  symbols: 0');
  });

  it('reports processes and communities as unavailable when index is missing', () => {
    const result: DiffReviewResult = {
      ...emptyResultForAcceptance,
      affectedProcesses: [],
      affectedCommunities: [],
      graphSections: { processesAvailable: false, communitiesAvailable: false },
    };
    const text = formatReviewDiffText('--cached', result, 'stale', 'no index', []);
    expect(text).toContain('processes: unavailable');
    expect(text).toContain('communities: unavailable');
  });
});

// ---- staged ---------------------------------------------------------------

describe('REV-3 acceptance: staged', () => {
  it('produces --cached range for staged diff', () => {
    const args = buildReviewDiffArgs({ staged: true });
    expect(args.resolvedRange).toBe('--cached');
    expect(args.nameOnly).toContain('--cached');
  });

  it('formatReviewDiffText shows staged range label', () => {
    const text = formatReviewDiffText('--cached', emptyResultForAcceptance, 'fresh', 'ok', []);
    expect(text).toContain('review diff: --cached');
  });
});

// ---- branch-range ---------------------------------------------------------

describe('REV-3 acceptance: branch-range', () => {
  it('produces correct range from --base and --head', () => {
    const args = buildReviewDiffArgs({ base: 'main', head: 'feature/x' });
    expect(args.resolvedRange).toBe('main..feature/x');
  });

  it('formatReviewDiffText shows branch range label', () => {
    const text = formatReviewDiffText(
      'main..feature/x',
      emptyResultForAcceptance,
      'fresh',
      'ok',
      [],
    );
    expect(text).toContain('review diff: main..feature/x');
  });
});

// ---- partial-sidecar / partial graph data ----------------------------------

describe('REV-3 acceptance: partial-sidecar', () => {
  it('shows processes available but communities unavailable (partial failure)', () => {
    const result: DiffReviewResult = {
      ...emptyResultForAcceptance,
      affectedProcesses: [
        { id: 'p3', name: 'Deploy Flow', processType: 'deploy', changedStepCount: 1 },
      ],
      affectedCommunities: [],
      graphSections: { processesAvailable: true, communitiesAvailable: false },
      warnings: ['community enrichment unavailable: query timeout'],
    };
    const text = formatReviewDiffText('main..HEAD', result, 'fresh', 'ok', result.warnings);
    expect(text).toContain('processes (1)');
    expect(text).toContain('Deploy Flow');
    expect(text).toContain('communities: unavailable');
    expect(text).toContain('community enrichment unavailable');
  });

  it('shows communities available but processes unavailable (partial failure)', () => {
    const result: DiffReviewResult = {
      ...emptyResultForAcceptance,
      affectedProcesses: [],
      affectedCommunities: [{ id: 'c2', name: 'Storage', changedSymbolCount: 3 }],
      graphSections: { processesAvailable: false, communitiesAvailable: true },
      warnings: ['process enrichment unavailable: lbug error'],
    };
    const text = formatReviewDiffText('main..HEAD', result, 'fresh', 'ok', result.warnings);
    expect(text).toContain('processes: unavailable');
    expect(text).toContain('communities (1)');
    expect(text).toContain('Storage');
  });
});

// ---- compatibility --------------------------------------------------------

describe('REV-3 acceptance: compatibility', () => {
  it('DiffReviewResult without new fields is valid (backward compatible)', () => {
    // Callers that don't supply REV-3 fields must still type-check and work.
    const result: DiffReviewResult = {
      reviewedFiles: [],
      totalSymbolsChanged: 0,
      highRiskSymbols: [],
      warnings: [],
    };
    // affectedProcesses/affectedCommunities/graphSections all optional
    expect(result.affectedProcesses).toBeUndefined();
    expect(result.affectedCommunities).toBeUndefined();
    expect(result.graphSections).toBeUndefined();
  });

  it('formatReviewDiffText does not crash when new fields are absent', () => {
    const result: DiffReviewResult = {
      reviewedFiles: [fileWithSymbol('src/x.ts', 'xFn')],
      totalSymbolsChanged: 1,
      highRiskSymbols: [],
      warnings: [],
      // no affectedProcesses/affectedCommunities/graphSections
    };
    expect(() => formatReviewDiffText('main..HEAD', result, 'fresh', 'ok', [])).not.toThrow();
  });

  it('cross-community hints do not appear when communities are empty', () => {
    const result: DiffReviewResult = {
      ...emptyResultForAcceptance,
      affectedCommunities: [],
      crossCommunityRiskReasons: [],
      graphSections: { processesAvailable: true, communitiesAvailable: true },
    };
    const text = formatReviewDiffText('main..HEAD', result, 'fresh', 'ok', []);
    expect(text).not.toContain('cross-community hints');
  });

  it('cross-community hints shown as ranking aids when multiple communities', () => {
    const result: DiffReviewResult = {
      ...emptyResultForAcceptance,
      reviewedFiles: [fileWithSymbol('src/a.ts', 'aFn', 'HIGH')],
      totalSymbolsChanged: 1,
      highRiskSymbols: ['aFn'],
      affectedCommunities: [
        { id: 'c1', name: 'Auth', changedSymbolCount: 1 },
        { id: 'c2', name: 'API', changedSymbolCount: 1 },
      ],
      crossCommunityRiskReasons: [
        'changes span 2 communities: Auth, API',
        'high-risk symbols in cross-community change: aFn',
      ],
      graphSections: { processesAvailable: true, communitiesAvailable: true },
    };
    const text = formatReviewDiffText('main..HEAD', result, 'fresh', 'ok', []);
    expect(text).toContain('cross-community hints');
    expect(text).toContain('changes span 2 communities');
    expect(text).toContain('high-risk symbols in cross-community change: aFn');
    // Full impact count still present
    expect(text).toContain('[HIGH] aFn');
    expect(text).toContain('↑60 callers');
  });
});

// ---------------------------------------------------------------------------
// REV-4: Help/docs contract tests
// ---------------------------------------------------------------------------

import { registerReviewCommands } from '../../src/cli/review.js';
import { Command } from 'commander';

/**
 * Return the full help output for the `review diff` subcommand, including
 * addHelpText('after', ...) content which is emitted via Commander events.
 */
function getReviewDiffHelp(): string {
  const program = new Command();
  registerReviewCommands(program);
  const reviewCmd = program.commands.find((c) => c.name() === 'review');
  const diffCmd = reviewCmd?.commands.find((c) => c.name() === 'diff');
  if (!diffCmd) return '';
  let output = '';
  diffCmd.configureOutput({
    writeOut: (s) => {
      output += s;
    },
    writeErr: (s) => {
      output += s;
    },
  });
  diffCmd.outputHelp();
  return output;
}

describe('REV-4: review diff help — local-only contract', () => {
  it('names local-only behavior in description', () => {
    const help = getReviewDiffHelp();
    expect(help).toMatch(/local/i);
    expect(help).toMatch(/offline|no hosted|no.*credential/i);
  });

  it('mentions ontoindex analyze as prerequisite', () => {
    const help = getReviewDiffHelp();
    expect(help).toContain('ontoindex analyze');
  });

  it('shows example for staged diff', () => {
    const help = getReviewDiffHelp();
    expect(help).toContain('--staged');
  });

  it('shows example for branch diff (--base)', () => {
    const help = getReviewDiffHelp();
    expect(help).toContain('--base main');
  });

  it('shows example for explicit range', () => {
    const help = getReviewDiffHelp();
    expect(help).toContain('--range');
  });

  it('describes --json as machine-readable', () => {
    const help = getReviewDiffHelp();
    expect(help).toMatch(/json.*machine|machine.*json/i);
  });

  it('mentions review-bundle export and how to use it', () => {
    const help = getReviewDiffHelp();
    // review-bundle export is now available via `ontoindex export review-bundle`
    expect(help).toMatch(/export review-bundle|review.bundle/i);
  });

  it('does not imply automatic indexing', () => {
    const help = getReviewDiffHelp();
    // Should not contain wording that suggests auto-index or auto-fetch
    expect(help).not.toMatch(/auto.index|auto.fetch|auto.rebase/i);
  });
});

describe('REV-4: review diff help — stale-index messaging', () => {
  it('formatReviewDiffText surfaces the analyze suggestion from a missing-index warning', () => {
    const result: DiffReviewResult = {
      reviewedFiles: [{ path: 'src/x.ts', addedLines: 1, removedLines: 0, changedSymbols: [] }],
      totalSymbolsChanged: 0,
      highRiskSymbols: [],
      warnings: [
        'no OntoIndex index found; symbol analysis unavailable — run `ontoindex analyze` first',
      ],
    };
    const text = formatReviewDiffText('--cached', result, 'stale', 'no index', result.warnings);
    expect(text).toContain('ontoindex analyze');
  });

  it('formatReviewDiffText shows stale freshness without hiding impact counts', () => {
    const result: DiffReviewResult = {
      reviewedFiles: [
        {
          path: 'src/api.ts',
          addedLines: 3,
          removedLines: 1,
          changedSymbols: [
            {
              nodeId: 'n1',
              name: 'handleReq',
              impact: { upstreamCount: 20, downstreamCount: 2, risk: 'MEDIUM', heuristic: false },
            },
          ],
        },
      ],
      totalSymbolsChanged: 1,
      highRiskSymbols: [],
      warnings: [],
    };
    const text = formatReviewDiffText(
      'main..HEAD',
      result,
      'stale',
      'indexedHead != targetHead',
      [],
    );
    // Stale but impact counts still visible
    expect(text).toContain('freshness: stale');
    expect(text).toContain('[MEDIUM] handleReq');
    expect(text).toContain('↑20 callers');
  });
});
