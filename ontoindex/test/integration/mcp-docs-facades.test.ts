import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    executeParameterized: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

import { ONTOINDEX_FACADE_TOOLS } from '../../src/mcp/facade/tool-definitions.js';
import { DocsMcpSchema, type RepoHandle } from '../../src/mcp/local/tool-params.js';
import { runDocsMcpAction } from '../../src/mcp/super/docs.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../src/mcp/super/tool-definitions.js';
import {
  recordEvidenceReadSafe,
  resetEvidenceReadLedgerForTests,
} from '../../src/core/runtime/evidence-read-ledger.js';

const repoPaths: string[] = [];

describe('MCP Docs Facade Integration', () => {
  beforeEach(() => {
    resetEvidenceReadLedgerForTests();
    lbugMocks.executeParameterized.mockReset();
    lbugMocks.executeParameterized.mockResolvedValue([]);
  });

  afterEach(async () => {
    await Promise.all(
      repoPaths.splice(0).map((repoPath) => rm(repoPath, { recursive: true, force: true })),
    );
  });

  it('returns skip metadata when the docs sidecar is missing', async () => {
    const repo = await tempRepoHandle();

    const result = await runDocsMcpAction(repo, { action: 'trace' });

    expect(result.sidecar.status).toBe('missing');
    expect(result.skipReasons).toContain('sidecar-missing');
    expect(result.docsEvidence).toEqual([]);
    expect(result.primaryGraphFacts).toEqual([]);
  });

  it('degrades stale sidecar trace evidence and keeps ambiguous links explicit', async () => {
    const repo = await tempRepoHandle();
    await writeSidecar(repo, [requirement('REQ-1'), resolution('REQ-1', 'ambiguous', 2)], {
      sourceCommitHash: 'old-commit',
    });

    const result = await runDocsMcpAction(repo, { action: 'trace', id: 'REQ-1' });

    expect(result.sidecar.status).toBe('stale');
    expect(result.skipReasons).toContain('sidecar-stale');
    expect(result.docsEvidence[0]).toMatchObject({
      requirementId: 'REQ-1',
      status: 'stale',
      implementationEvidence: [
        expect.objectContaining({
          status: 'ambiguous',
          candidateCount: 2,
        }),
      ],
    });
  });

  it('returns compact docs drift evidence', async () => {
    const repo = await tempRepoHandle();
    await writeSidecar(repo, [apiSpec('GET', '/v1/items')]);

    const result = await runDocsMcpAction(repo, { action: 'drift' });

    expect(result.report).toBe('api-drift');
    expect(result.docsEvidence[0]).toMatchObject({
      routeKey: 'GET /v1/items',
      status: 'documented-missing-in-code',
      docs: [expect.objectContaining({ source: 'doc', method: 'GET', path: '/v1/items' })],
      code: [],
    });
  });

  it('summarizes material docs and graph reads for drift without candidate read amplification', async () => {
    const repo = await tempRepoHandle();
    await writeSidecar(repo, [apiSpec('GET', '/v1/items')]);
    lbugMocks.executeParameterized.mockResolvedValueOnce([
      { path: '/v1/items', sourceFile: 'src/routes.ts', handler: 'route:/v1/items' },
    ]);

    const result = await runDocsMcpAction(repo, { action: 'drift' });

    expect(result.docsEvidence).toHaveLength(1);
    expect(result.primaryGraphFacts).toEqual([
      expect.objectContaining({
        kind: 'code-route',
        routeKey: '* /v1/items',
        path: '/v1/items',
        filePath: 'src/routes.ts',
      }),
    ]);
    expect(result.basedOnReads).toMatchObject({
      docs_evidence: 3,
      graph_evidence: 1,
    });
  });

  it('does not record speculative ambiguous trace candidates as material reads', async () => {
    const repo = await tempRepoHandle();
    await writeSidecar(repo, [requirement('REQ-1'), resolution('REQ-1', 'ambiguous', 3)]);

    const result = await runDocsMcpAction(repo, { action: 'trace', id: 'REQ-1' });

    expect(result.primaryGraphFacts).toHaveLength(3);
    expect(result.basedOnReads).toMatchObject({
      docs_evidence: 3,
      graph_evidence: 0,
    });
  });

  it('preserves response truncation metadata for docs trace', async () => {
    const repo = await tempRepoHandle();
    await writeSidecar(repo, [requirement('REQ-1'), requirement('REQ-2')]);

    const result = await runDocsMcpAction(repo, { action: 'trace', maxItems: 1 });

    expect(result.docsEvidence).toHaveLength(1);
    expect(result.limits.truncated).toBe(true);
    expect(result.limits).toMatchObject({ maxItems: 1, emitted: 1 });
  });

  it('defaults docs trace questions to a compact bounded response', async () => {
    const repo = await tempRepoHandle();
    await writeSidecar(
      repo,
      Array.from({ length: 30 }, (_, index) => requirement(`REQ-${index + 1}`)),
    );

    const result = await runDocsMcpAction(repo, { action: 'trace' });

    expect(result.docsEvidence).toHaveLength(25);
    expect(result.limits).toMatchObject({ maxItems: 25, emitted: 25, truncated: true });
    expect(result.warnings).toEqual(expect.any(Array));
  });

  it('keeps degraded docs sidecar state visible in compact readiness output', async () => {
    const repo = await tempRepoHandle();
    await writeSidecar(repo, [requirement('REQ-1')], { status: 'partial' });

    const result = await runDocsMcpAction(repo, { action: 'readiness' });

    expect(['partial', 'stale']).toContain(result.sidecar.status);
    expect(
      result.skipReasons.some(
        (reason) => reason === 'sidecar-partial' || reason === 'sidecar-stale',
      ),
    ).toBe(true);
    expect(result.limits.maxItems).toBe(25);
  });

  it('clamps docs response limits to the schema maximums', async () => {
    const repo = await tempRepoHandle();
    await writeSidecar(repo, [requirement('REQ-1')]);

    const result = await runDocsMcpAction(repo, {
      action: 'trace',
      maxItems: 10_000,
      maxCandidatesPerFact: 10_000,
    });

    expect(result.limits.maxItems).toBe(100);
    expect(result.limits.maxCandidatesPerFact).toBe(20);
  });

  it('exposes docs inline context as an opt-in derived MCP formatter', async () => {
    const docsTool = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'docs')!;
    const superDocsTool = ONTOINDEX_SUPER_TOOLS.find((tool) => tool.name === 'gn_docs')!;
    const repo = await tempRepoHandle();
    await writeSidecar(repo, [requirement('REQ-1')]);

    expect(docsTool.inputSchema.properties.format).toMatchObject({
      type: 'string',
      enum: ['json', 'inline', 'both'],
    });
    expect(superDocsTool.inputSchema.properties.format).toMatchObject({
      type: 'string',
      enum: ['json', 'inline', 'both'],
    });

    const defaultResult = await runDocsMcpAction(repo, { action: 'trace' });
    const inlineResult = await runDocsMcpAction(repo, {
      action: 'trace',
      format: 'inline',
      maxTokens: 120,
      maxEvidenceItems: 1,
    });
    const clampedResult = await runDocsMcpAction(repo, {
      action: 'trace',
      format: 'inline',
      maxTokens: 100_000,
      maxEvidenceItems: 100_000,
    });

    expect(defaultResult.inlineContext).toBeUndefined();
    expect(inlineResult.inlineContext).toMatchObject({
      version: 1,
      kind: 'trace',
      metadata: {
        formatter: 'docs-inline-context',
        maxTokens: 120,
      },
    });
    expect(inlineResult.inlineContext?.text).toContain('Claim: requirement-trace');
    expect(clampedResult.inlineContext?.metadata.maxTokens).toBe(4000);
  });

  it('accepts includeMemories in the local schema and public docs tool definitions', () => {
    const docsTool = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'docs')!;
    const superDocsTool = ONTOINDEX_SUPER_TOOLS.find((tool) => tool.name === 'gn_docs')!;

    expect(DocsMcpSchema.parse({ action: 'context', includeMemories: true })).toMatchObject({
      action: 'context',
      includeMemories: true,
    });
    expect(docsTool.inputSchema.properties.includeMemories).toMatchObject({
      type: 'boolean',
    });
    expect(superDocsTool.inputSchema.properties.includeMemories).toMatchObject({
      type: 'boolean',
    });
  });

  it('adds bounded advisory knowledge concepts to docs context without graph promotion', async () => {
    const repo = await tempRepoHandle();
    await writeSidecar(repo, [requirement('REQ-1'), resolution('REQ-1'), requirement('REQ-2')]);

    const firstPage = await runDocsMcpAction(repo, { action: 'context', maxItems: 1 });
    const secondPage = await runDocsMcpAction(repo, {
      action: 'context',
      maxItems: 1,
      cursor: firstPage.cursor?.next,
    });

    expect(firstPage.report).toBe('docs-context');
    expect(firstPage.docsEvidence).toHaveLength(1);
    expect(firstPage.docsEvidence[0]).toMatchObject({
      kind: 'knowledge-concept',
      evidenceClass: 'docs_evidence',
      authority: 'advisory',
      sourceDocuments: ['docs/requirements.md'],
      linkedGraphIdentities: expect.arrayContaining([expect.objectContaining({ type: 'symbol' })]),
    });
    expect(firstPage.primaryGraphFacts).toEqual([]);
    expect(firstPage.summary.knowledge).toMatchObject({
      totalConcepts: 2,
      emittedConcepts: 2,
      authority: 'advisory',
    });
    expect(firstPage.limits).toMatchObject({ maxItems: 1, emitted: 1, total: 2, truncated: true });
    expect(firstPage.cursor?.next).toEqual(expect.any(String));
    expect(secondPage.docsEvidence).toHaveLength(1);
    expect(secondPage.primaryGraphFacts).toEqual([]);
  });

  it('summarizes advisory knowledge concepts for docs context summary responses', async () => {
    const repo = await tempRepoHandle();
    await writeSidecar(repo, [requirement('REQ-1'), resolution('REQ-1')]);

    const result = await runDocsMcpAction(repo, { action: 'context', summary: true });

    expect(result.responseMode).toBe('summary');
    expect(result.docsEvidence[0]).toMatchObject({
      kind: 'knowledge-concept',
      evidenceClass: 'docs_evidence',
      authority: 'advisory',
      linkedGraphIdentityCount: 1,
    });
    expect(result.docsEvidence[0]).not.toHaveProperty('linkedGraphIdentities');
    expect(result.primaryGraphFacts).toEqual([]);
  });

  it('keeps docs context minimal output compact while exposing knowledge state', async () => {
    const repo = await tempRepoHandle();
    await writeSidecar(repo, [requirement('REQ-1'), requirement('REQ-2')]);

    const result = await runDocsMcpAction(repo, {
      action: 'context',
      minimal: true,
      maxItems: 1,
    });

    expect(result.responseMode).toBe('minimal');
    expect(result).not.toHaveProperty('docsEvidence');
    expect(result.result.summary.knowledge).toMatchObject({
      totalConcepts: 2,
      emittedConcepts: 2,
      authority: 'advisory',
    });
    expect(result.result).toMatchObject({ emitted: 1, total: 2, truncated: true });
    expect(result.cursor?.next).toEqual(expect.any(String));
  });

  it('keeps missing docs context sidecar skip reasons while exposing empty knowledge state', async () => {
    const repo = await tempRepoHandle();

    const result = await runDocsMcpAction(repo, { action: 'context', minimal: true });

    expect(result.result.sidecarStatus).toBe('missing');
    expect(result.result.skipReasons).toContain('sidecar-missing');
    expect(result.result.summary.knowledge).toMatchObject({
      totalConcepts: 0,
      sidecarStatus: 'missing',
      authority: 'advisory',
    });
    expect(result.nextAction).toBe(
      'Markdown docs sidecar is missing; run `ontoindex docs refresh` or `ontoindex analyze --markdown-sidecar` before relying on this report.',
    );
  });

  it('keeps stale docs context sidecar skip reasons and refresh guidance', async () => {
    const repo = await tempRepoHandle();
    await writeSidecar(repo, [requirement('REQ-1')], { sourceCommitHash: 'old-commit' });

    const result = await runDocsMcpAction(repo, { action: 'context' });

    expect(result.sidecar.status).toBe('stale');
    expect(result.skipReasons).toContain('sidecar-stale');
    expect(result.summary.knowledge).toMatchObject({
      sidecarStatus: 'stale',
      staleConcepts: 1,
      authority: 'advisory',
    });
    expect(result.docsEvidence[0]).toMatchObject({ freshness: 'stale' });
    expect(result.nextAction).toBe(
      'Run `ontoindex docs refresh` (or `ontoindex analyze --markdown-sidecar`) before using this report for write decisions.',
    );
  });

  it('adds advisory memory metadata to context only when includeMemories is true', async () => {
    const repo = await tempRepoHandle();
    await writeMemory(repo, 'onboarding.md');

    const withoutMemories = await runDocsMcpAction(repo, { action: 'context' });
    const withMemories = await runDocsMcpAction(repo, {
      action: 'context',
      includeMemories: true,
      format: 'both',
    });

    expect(withoutMemories).not.toHaveProperty('advisoryMemories');
    expect(withMemories.docsEvidence).toEqual([]);
    expect(withMemories.primaryGraphFacts).toEqual([]);
    expect(withMemories.advisoryMemories).toMatchObject({
      boundary: 'advisory-only',
      availability: { status: 'available', total: 1 },
      validity: { valid: 1, invalid: 0 },
      freshness: { fresh: 1, 'stale-index': 0, unknown: 0, invalid: 0 },
    });
    expect(withMemories.inlineContext?.text).toContain('Advisory memories:');
    expect(withMemories.inlineContext?.text).toContain('availability: available; total=1');
  });

  it('ignores includeMemories for trace and drift output', async () => {
    const repo = await tempRepoHandle();
    await writeSidecar(repo, [requirement('REQ-1'), apiSpec('GET', '/v1/items')]);
    await writeMemory(repo, 'onboarding.md');

    const traceDefault = await runDocsMcpAction(repo, { action: 'trace' });
    resetEvidenceReadLedgerForTests();
    const traceWithMemories = await runDocsMcpAction(repo, {
      action: 'trace',
      includeMemories: true,
    });
    resetEvidenceReadLedgerForTests();
    const driftDefault = await runDocsMcpAction(repo, { action: 'drift' });
    resetEvidenceReadLedgerForTests();
    const driftWithMemories = await runDocsMcpAction(repo, {
      action: 'drift',
      includeMemories: true,
    });

    expect(traceWithMemories).toEqual(traceDefault);
    expect(driftWithMemories).toEqual(driftDefault);
  });

  it('proves ledger staleness does not affect organic readiness verdicts', async () => {
    const repo = await tempRepoHandle();
    await writeSidecar(repo, [requirement('REQ-1')]);

    // 1. Run readiness normally
    const baseline = await runDocsMcpAction(repo, { action: 'readiness' });
    // In temp environments, it might be 'stale' due to missing .git, which is fine for this test
    expect(['available', 'stale']).toContain(baseline.sidecar.status);
    const baselineStatus = baseline.sidecar.status;

    // 2. Inject STALE state into the ledger
    resetEvidenceReadLedgerForTests();
    recordEvidenceReadSafe({
      readClass: 'graph_evidence',
      surface: 'mcp',
      target: 'fake-stale',
      targetType: 'symbol',
      memoryFreshness: 'stale-index',
    });

    // 3. Run readiness again
    const staleResult = await runDocsMcpAction(repo, { action: 'readiness' });

    // 4. Verify that 'basedOnReads' shows stale:true but organic status is unchanged
    expect(staleResult.basedOnReads?.stale).toBe(true);
    expect(staleResult.sidecar.status).toBe(baselineStatus);
    expect(staleResult.summary).toEqual(baseline.summary);
  });

  it('keeps readiness status unchanged when advisory memories are present or invalid', async () => {
    const repo = await tempRepoHandle();
    await writeSidecar(repo, [requirement('REQ-1')], { status: 'partial' });
    await writeMemory(repo, 'fresh.md');
    await writeMemory(repo, 'invalid.md', ['sources:']);

    const withoutMemories = await runDocsMcpAction(repo, { action: 'readiness' });
    const withMemories = await runDocsMcpAction(repo, {
      action: 'readiness',
      includeMemories: true,
      format: 'both',
    });

    expect(withMemories.sidecar).toEqual(withoutMemories.sidecar);
    expect(withMemories.summary).toEqual(withoutMemories.summary);
    expect(withMemories.skipReasons).toEqual(withoutMemories.skipReasons);
    expect(withMemories.advisoryMemories).toMatchObject({
      boundary: 'advisory-only',
      availability: { status: 'available', total: 2 },
      validity: { valid: 1, invalid: 1 },
      freshness: { fresh: 1, 'stale-index': 0, unknown: 0, invalid: 1 },
    });
    expect(withMemories.inlineContext?.text).toContain('Advisory memories:');
    expect(withMemories.inlineContext?.text).toContain('validity: valid=1; invalid=1');
  });
});

async function tempRepoHandle(): Promise<RepoHandle> {
  const scratchRoot = join(process.cwd(), '.vitest-docs-repos');
  await mkdir(scratchRoot, { recursive: true });
  const repoPath = await mkdtemp(join(scratchRoot, 'ontoindex-docs-mcp-repo-'));
  repoPaths.push(repoPath);
  const storagePath = join(repoPath, '.ontoindex');
  return {
    id: 'fixture',
    name: 'fixture',
    repoPath,
    path: repoPath,
    storagePath,
    lbugPath: join(storagePath, 'graph.lbug'),
    indexedAt: 'index-1',
    lastCommit: 'abc123',
    stats: { files: 1, nodes: 1, edges: 0 },
  };
}

async function writeSidecar(
  repo: RepoHandle,
  records: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const dir = join(repo.storagePath, 'enrichment');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'sidecar-store.json'),
    JSON.stringify({
      schemaVersion: 1,
      requests: [],
      lock: null,
      enrichments: [
        {
          sourceIndexId: 'index-1',
          sourceCommitHash: 'abc123',
          schemaVersion: 1,
          analyzerId: 'markdown-document-sidecar',
          analyzerVersion: '1.0.0',
          filePath: 'docs/requirements.md',
          fileHash: 'hash-1',
          status: 'complete',
          confidence: 1,
          records,
          ...overrides,
        },
      ],
    }),
  );
}

async function writeMemory(
  repo: RepoHandle,
  fileName: string,
  overrides: string[] = [],
  bodyLines: string[] = ['# Advisory memory'],
): Promise<void> {
  const dir = join(repo.storagePath, 'memories');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), makeMemoryContent(overrides, bodyLines));
}

function makeMemoryContent(overrides: string[] = [], bodyLines: string[] = ['# Memory']): string {
  return [
    '---',
    'version: 1',
    'repo: fixture',
    'created_at: 2026-01-01',
    'source_commit: abc123',
    'indexed_commit: abc123',
    'freshness: fresh',
    'kind: advisory',
    'not_audit_evidence: true',
    'sources:',
    '  - docs/requirements.md',
    ...overrides,
    '---',
    ...bodyLines,
  ].join('\n');
}

function requirement(requirementId: string): Record<string, unknown> {
  return {
    kind: 'markdown-requirement',
    schemaVersion: 1,
    docPath: 'docs/requirements.md',
    headingPath: [requirementId],
    lineSpan: { start: 1, end: 1 },
    sourceChunkKey: `chunk:${requirementId}`,
    normalizedKey: requirementId,
    confidence: 1,
    evidence: {
      text: `${requirementId} requirement`,
      raw: `${requirementId} requirement`,
      lineSpan: { start: 1, end: 1 },
    },
    requirementId,
    title: `${requirementId} title`,
    source: 'heading',
  };
}

function resolution(
  factKey: string,
  status: 'resolved' | 'ambiguous' = 'resolved',
  candidateCount = 1,
): Record<string, unknown> {
  const candidates = Array.from({ length: candidateCount }, (_, index) => ({
    type: 'symbol',
    id: `symbol:${factKey}:${index}`,
    filePath: `src/feature-${index}.ts`,
    confidence: 0.7,
  }));
  return {
    kind: 'markdown-doc-resolution',
    schemaVersion: 1,
    resolverId: 'ontoindex.markdown-doc-resolver',
    resolverVersion: '1.0.0',
    sourceIndexId: 'index-1',
    sourceCommitHash: 'abc123',
    graphSchemaVersion: 1,
    docPath: 'docs/requirements.md',
    factKey,
    factKind: 'markdown-requirement',
    subjectKind: 'requirement',
    resolutionKey: `resolution:${factKey}`,
    status,
    confidence: 0.8,
    evidenceKind: 'lexical-requirement-id',
    reasons: status === 'ambiguous' ? ['multiple-candidates'] : ['single-candidate'],
    targetGraphIdentity: status === 'resolved' ? candidates[0] : undefined,
    candidates,
    lineSpan: { start: 1, end: 1 },
  };
}

function apiSpec(method: string, path: string): Record<string, unknown> {
  return {
    kind: 'markdown-api-spec',
    schemaVersion: 1,
    docPath: 'docs/api.md',
    headingPath: ['API'],
    lineSpan: { start: 1, end: 1 },
    sourceChunkKey: 'chunk:api',
    normalizedKey: `${method} ${path}`,
    confidence: 0.9,
    evidence: {
      text: `${method} ${path}`,
      raw: `${method} ${path}`,
      lineSpan: { start: 1, end: 1 },
    },
    method,
    path,
    routeKey: `${method} ${path}`,
  };
}
