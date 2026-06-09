import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import replayFixture from '../fixtures/replay/typed-retrieval-replay.json' with { type: 'json' };

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

vi.mock('../../src/mcp/local/backend-query.js', () => ({
  bm25Search: vi.fn(),
  semanticSearch: vi.fn(),
}));

vi.mock('../../src/core/search/graph-traversal-rank.js', () => ({
  graphTraversalRank: vi.fn(),
}));

vi.mock('../../src/mcp/local/query-log.js', () => ({
  appendQueryLog: vi.fn(),
}));

vi.mock('../../src/core/search/intent-classifier.js', () => ({
  classifyIntent: vi.fn(),
}));

vi.mock('../../src/mcp/shared/target-context.js', () => ({
  resolveTargetContext: vi.fn(),
}));

import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { applyEnsemble } from '../../src/core/search/per-intent-ensemble.js';
import type { EnrichedSymbolRow } from '../../src/core/search/symbol-merge.js';
import { classifyIntent } from '../../src/core/search/intent-classifier.js';
import { graphTraversalRank } from '../../src/core/search/graph-traversal-rank.js';
import { validateOrganicRecommendation } from '../../src/core/recommendations/organic.js';
import { bm25Search, semanticSearch } from '../../src/mcp/local/backend-query.js';
import { query } from '../../src/mcp/local/backend-search.js';
import { appendQueryLog } from '../../src/mcp/local/query-log.js';
import { resolveTargetContext } from '../../src/mcp/shared/target-context.js';

type ReplayIntent = 'calls-of' | 'cross-file-impact' | 'nl-conceptual' | 'ambiguous' | 'identifier';

interface ReplayRow extends EnrichedSymbolRow {
  bm25Score?: number;
  semanticScore?: number;
  score?: number;
}

interface QueryReplayFixture {
  id: string;
  classifier: {
    intent: ReplayIntent;
    confidence?: number;
    matchedKeywords: string[];
  };
  params: Record<string, unknown>;
  embeddingsAvailable?: boolean;
  bm25Results?: ReplayRow[];
  semanticResults?: ReplayRow[];
  graphResults?: ReplayRow[];
  exactSymbolResults?: ReplayRow[];
  exactFileResults?: ReplayRow[];
  targetContextOverrides?: Record<string, unknown>;
  expected: {
    definitionNames: string[];
    candidateIds: string[];
    candidateSources: string[];
    evidenceKinds: string[];
    evidenceRetrievals: string[];
    callCounts: {
      bm25: number;
      semantic: number;
      graph: number;
    };
    warningContains?: string[];
    freshnessStatus?: string;
    capabilitiesMissing?: string[];
    capabilityWarnings?: string[];
  };
}

interface EnsembleReplayFixture {
  id: string;
  intent: ReplayIntent;
  confidence?: number;
  limit: number;
  bm25Results: ReplayRow[];
  semanticResults: ReplayRow[];
  graphResults?: ReplayRow[];
  expected: Array<{
    key: string;
    name: string;
    score: number;
    trace: Array<{
      source: 'bm25' | 'semantic' | 'graph';
      rank: number;
      rawScore: number;
      weight: number;
      contribution: number;
    }>;
  }>;
}

interface OrganicReplayFixture {
  id: string;
  callableToolNames: string[];
  input: {
    id: string;
    action: string;
    target: {
      kind: 'symbol' | 'file' | 'process' | 'doc' | 'test' | 'route' | 'module';
      name: string;
      filePath?: string;
      startLine?: number;
    };
    reason: string;
    confidence: 'low' | 'medium' | 'high';
    evidenceIds: string[];
    nextTools: string[];
  };
  expectedErrorFields: string[];
}

interface ReplayFixtureFile {
  queryReplays: QueryReplayFixture[];
  ensembleReplays: EnsembleReplayFixture[];
  organicReplays: OrganicReplayFixture[];
}

const fixtures = replayFixture as ReplayFixtureFile;

const mockExecuteParameterized = vi.mocked(executeParameterized);
const mockBm25Search = vi.mocked(bm25Search);
const mockSemanticSearch = vi.mocked(semanticSearch);
const mockGraphTraversalRank = vi.mocked(graphTraversalRank);
const mockAppendQueryLog = vi.mocked(appendQueryLog);
const mockClassifyIntent = vi.mocked(classifyIntent);
const mockResolveTargetContext = vi.mocked(resolveTargetContext);

let currentQueryReplay: QueryReplayFixture | undefined;
let replayRepoPath: string | undefined;

describe('search replay fixtures', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    currentQueryReplay = undefined;
    replayRepoPath = await mkdtemp(join(tmpdir(), 'ontoindex-search-replay-'));

    mockAppendQueryLog.mockResolvedValue(undefined);
    mockClassifyIntent.mockImplementation(
      () =>
        currentQueryReplay?.classifier ?? {
          intent: 'ambiguous',
          confidence: 0.8,
          matchedKeywords: [],
        },
    );
    mockBm25Search.mockImplementation(async () => ({
      results: currentQueryReplay?.bm25Results ?? [],
      ftsUsed: true,
    }));
    mockSemanticSearch.mockImplementation(async () => currentQueryReplay?.semanticResults ?? []);
    mockGraphTraversalRank.mockImplementation(async () => currentQueryReplay?.graphResults ?? []);
    mockExecuteParameterized.mockImplementation(async (_repoId, statement) => {
      const sql = String(statement);
      if (sql.includes('MATCH (e:CodeEmbedding)')) {
        return currentQueryReplay?.embeddingsAvailable === false ? [] : [{ nodeId: 'embedding:1' }];
      }
      if (sql.includes('WHERE n.id = $symbolQuery OR n.name = $symbolQuery')) {
        return toLookupRows(currentQueryReplay?.exactSymbolResults);
      }
      if (sql.includes('MATCH (n:File)')) {
        return toLookupRows(currentQueryReplay?.exactFileResults);
      }
      return [];
    });
    mockResolveTargetContext.mockResolvedValue(targetContext());
  });

  afterEach(async () => {
    if (replayRepoPath) {
      await rm(replayRepoPath, { recursive: true, force: true });
      replayRepoPath = undefined;
    }
  });

  for (const replay of fixtures.queryReplays) {
    it(`replays ${replay.id}`, async () => {
      currentQueryReplay = replay;
      mockResolveTargetContext.mockResolvedValue(targetContext(replay.targetContextOverrides));

      const result = await query(
        { id: 'repo-1', repoPath: replayRepoPath, lastCommit: 'abc123' },
        replay.params as Parameters<typeof query>[1],
      );

      expect('error' in result).toBe(false);
      expect('abstained' in result).toBe(false);
      if ('error' in result || 'abstained' in result) {
        throw new Error(`unexpected replay result for ${replay.id}`);
      }

      expect(result.definitions.map((entry) => entry.name)).toEqual(
        replay.expected.definitionNames,
      );
      expect(mockBm25Search).toHaveBeenCalledTimes(replay.expected.callCounts.bm25);
      expect(mockSemanticSearch).toHaveBeenCalledTimes(replay.expected.callCounts.semantic);
      expect(mockGraphTraversalRank).toHaveBeenCalledTimes(replay.expected.callCounts.graph);

      const structured = result.structured_retrieval;
      expect(structured).toBeDefined();
      expect(structured?.candidates.map((candidate) => candidate.id)).toEqual(
        replay.expected.candidateIds,
      );
      expect(structured?.candidates.map((candidate) => candidate.source)).toEqual(
        replay.expected.candidateSources,
      );
      expect(structured?.candidates.map((candidate) => candidate.evidence[0]?.kind)).toEqual(
        replay.expected.evidenceKinds,
      );
      expect(structured?.candidates.map((candidate) => candidate.evidence[0]?.retrieval)).toEqual(
        replay.expected.evidenceRetrievals,
      );

      for (const warning of replay.expected.warningContains ?? []) {
        expect(result.warning).toContain(warning);
      }

      if (replay.expected.freshnessStatus) {
        expect(structured?.capabilityState.freshness.status).toBe(replay.expected.freshnessStatus);
      }
      if (replay.expected.capabilitiesMissing?.length) {
        expect(structured?.capabilityState.capabilitiesMissing).toEqual(
          expect.arrayContaining(replay.expected.capabilitiesMissing),
        );
      }
      if (replay.expected.capabilityWarnings?.length) {
        expect(structured?.capabilityState.warnings).toEqual(
          expect.arrayContaining(replay.expected.capabilityWarnings),
        );
      }
    });
  }

  for (const replay of fixtures.ensembleReplays) {
    it(`replays ${replay.id}`, () => {
      const result = applyEnsemble(
        replay.intent,
        replay.bm25Results,
        replay.semanticResults,
        replay.limit,
        replay.confidence,
        replay.graphResults ?? [],
        [],
        [],
        { includeTrace: true },
      );

      expect(result).toHaveLength(replay.expected.length);
      replay.expected.forEach((expectedEntry, index) => {
        const [key, item] = result[index]!;
        expect(key).toBe(expectedEntry.key);
        expect(item.data.name).toBe(expectedEntry.name);
        expect(item.score).toBeCloseTo(expectedEntry.score, 12);
        expect(item.trace).toHaveLength(expectedEntry.trace.length);
        expectedEntry.trace.forEach((expectedTrace, traceIndex) => {
          const actualTrace = item.trace?.[traceIndex];
          expect(actualTrace).toMatchObject({
            source: expectedTrace.source,
            rank: expectedTrace.rank,
            rawScore: expectedTrace.rawScore,
            weight: expectedTrace.weight,
          });
          expect(actualTrace?.contribution).toBeCloseTo(expectedTrace.contribution, 12);
        });
      });
    });
  }

  for (const replay of fixtures.organicReplays) {
    it(`replays ${replay.id}`, () => {
      const result = validateOrganicRecommendation(replay.input, {
        callableToolNames: replay.callableToolNames,
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error(`expected rejection for ${replay.id}`);
      }
      expect(result.errors.map((error) => error.field)).toEqual(
        expect.arrayContaining(replay.expectedErrorFields),
      );
    });
  }
});

function toLookupRows(rows: ReplayRow[] | undefined): Array<Record<string, unknown>> {
  return (rows ?? []).map((row) => ({
    id: row.nodeId,
    name: row.name,
    type: row.type,
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
  }));
}

function targetContext(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    status: 'ok',
    repoKey: 'repo-1',
    repoPath: '/repo',
    branch: 'main',
    targetRef: 'HEAD',
    targetHead: 'abc123',
    currentHead: 'abc123',
    indexedHead: 'abc123',
    dirtyWorktree: false,
    changedSinceIndex: false,
    snapshotMode: 'committed-head',
    qualityMode: 'balanced',
    embeddings: { status: 'available', count: 10 },
    lsp: { status: 'unknown', reason: 'not-probed' },
    sidecar: { status: 'unknown', reason: 'not-probed' },
    policy: { status: 'unknown', reason: 'not-probed' },
    warnings: [],
    ...overrides,
  };
}
