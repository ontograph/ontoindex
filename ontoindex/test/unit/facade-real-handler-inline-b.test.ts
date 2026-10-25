import { describe, expect, it, vi } from 'vitest';

import { dispatchFacade } from '../../src/mcp/facade/dispatch.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { dispatchSuper, type SuperTool } from '../../src/mcp/super/dispatch.js';

const repo = { id: 'inline-fixture', repoPath: '/inline-fixture' };
const noSourceWarning = 'no source text or path supplied';

interface InlineRoute {
  action: string;
  tool: SuperTool;
  params: Record<string, unknown>;
  expected: Record<string, unknown>;
  inlineField: string;
  limitField: string;
  empty: Record<string, unknown>;
  warningField: string;
}

const routes: InlineRoute[] = [
  {
    action: 'error_topology',
    tool: 'gn_error_topology',
    params: { sourceText: 'int fd = open(path, O_RDONLY);\nexit(1);' },
    expected: {
      nodes: expect.arrayContaining([
        expect.objectContaining({ nodeKind: 'source', label: 'open' }),
      ]),
      findings: expect.arrayContaining([
        expect.objectContaining({ category: 'generic-exit-code' }),
      ]),
    },
    inlineField: 'sourceText',
    limitField: 'maxRecords',
    empty: { status: 'unresolved', nodes: [], findings: [] },
    warningField: 'warnings',
  },
  {
    action: 'concurrency',
    tool: 'gn_concurrency_audit',
    params: {
      sourceText: [
        'pthread_mutex_t workerLock;',
        'pthread_mutex_lock(&workerLock);',
        'sleep(1);',
        'pthread_mutex_unlock(&workerLock);',
      ].join('\n'),
    },
    expected: {
      lockDeclarations: expect.arrayContaining([
        expect.objectContaining({ lockName: 'workerLock' }),
      ]),
      findings: expect.arrayContaining([
        expect.objectContaining({ reasonCode: 'blocking-under-lock' }),
      ]),
    },
    inlineField: 'sourceText',
    limitField: 'maxFindings',
    empty: { status: 'complete', lockDeclarations: [], findings: [] },
    warningField: 'warnings',
  },
  {
    action: 'pressure',
    tool: 'gn_pressure_impact',
    params: { sourceText: 'static int activeCount = 0;\nactiveCount++;' },
    expected: {
      impactScope: 'ALL/global',
      constraints: expect.arrayContaining([
        expect.objectContaining({ name: 'activeCount', scope: 'global' }),
      ]),
      warnings: expect.arrayContaining([
        expect.objectContaining({ id: 'pressure:unbalanced:activeCount' }),
      ]),
    },
    inlineField: 'sourceText',
    limitField: 'maxWarnings',
    empty: { status: 'complete', constraints: [], warnings: [] },
    warningField: 'falsePositiveNotes',
  },
  {
    action: 'abi',
    tool: 'gn_abi_diff',
    params: {
      sourceStruct: 'struct Payload {\nuint64_t requestId;\n};',
      targetInterface: 'interface Payload {\nrequestId: number;\n}',
      sourceLanguage: 'cpp',
      targetLanguage: 'typescript',
    },
    expected: {
      findings: expect.arrayContaining([
        expect.objectContaining({ field: 'requestId', reasonCodes: ['UINT64_PRECISION_LOSS'] }),
      ]),
    },
    inlineField: 'sourceStruct',
    limitField: 'maxFindings',
    empty: {
      findings: [],
      systemsEvidence: [],
      skipReasons: ['source or target snippet yielded no comparable fields'],
    },
    warningField: 'warnings',
  },
];

function withoutRepoIdentity(record: Record<string, unknown>): Record<string, unknown> {
  const { repoLabel: _repoLabel, repoPath: _repoPath, ...report } = record;
  return report;
}

async function assertParity(
  route: InlineRoute,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const resolveRepo = vi.fn(async () => repo);
  const backend = { resolveRepo } as unknown as LocalBackend;
  const args = Object.freeze({ ...params });
  const direct = await dispatchSuper(route.tool, args, repo.id);
  const facade = (await dispatchFacade('audit', route.action, args, backend)) as Record<
    string,
    unknown
  >;

  expect(resolveRepo).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(facade).toMatchObject({ repoLabel: repo.id, repoPath: repo.repoPath });
  expect(withoutRepoIdentity(facade)).toEqual(direct);
  return direct as Record<string, unknown>;
}

async function assertErrorParity(
  route: InlineRoute,
  params: Record<string, unknown>,
  issue: string,
): Promise<void> {
  const backend = { resolveRepo: async () => repo } as unknown as LocalBackend;
  const args = Object.freeze({ ...params });
  const outcomes = await Promise.allSettled([
    dispatchSuper(route.tool, args, repo.id),
    dispatchFacade('audit', route.action, args, backend),
  ]);

  const errors = outcomes.map((outcome) => {
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('Expected dispatch rejection');
    expect(outcome.reason).toBeInstanceOf(Error);
    return outcome.reason as Error & Record<string, unknown>;
  });
  const [direct, facade] = errors;
  expect(direct.message).toBe(`Invalid arguments for ${route.tool}: ${issue}`);
  expect(facade.message).toBe(direct.message);
  expect(facade.name).toBe(direct.name);
  expect(withoutRepoIdentity({ ...facade })).toEqual({ ...direct });
  expect(facade).toMatchObject({ repoLabel: repo.id, repoPath: repo.repoPath });
}

describe.each(routes)('real inline audit/$action facade parity', (route) => {
  it('preserves the complete report and input-specific findings', async () => {
    const report = await assertParity(route, route.params);
    expect(report).toMatchObject({ tool: route.tool, ...route.expected });
  });

  // Missing/empty source is accepted by these real handlers, not a validation error.
  it('preserves missing-source empty results and the loader warning', async () => {
    const report = await assertParity(route, {});
    expect(report).toMatchObject(route.empty);
    expect(report[route.warningField]).toContain(noSourceWarning);
  });

  it('preserves explicitly empty inline input without a missing-source warning', async () => {
    const params =
      route.tool === 'gn_abi_diff' ? { sourceStruct: '', targetInterface: '' } : { sourceText: '' };
    const report = await assertParity(route, params);
    expect(report).toMatchObject(route.empty);
    expect(report[route.warningField]).not.toContain(noSourceWarning);
  });

  it('rejects a non-string inline source with identical error text and shape', async () => {
    await assertErrorParity(
      route,
      { ...route.params, [route.inlineField]: 42 },
      `${route.inlineField}: expected string`,
    );
  });

  it('rejects a non-numeric bound with identical error text and shape', async () => {
    await assertErrorParity(
      route,
      { ...route.params, [route.limitField]: 'many' },
      `${route.limitField}: expected number`,
    );
  });

  it('rejects a non-boolean legacyResponse with identical error text and shape', async () => {
    await assertErrorParity(
      route,
      { ...route.params, legacyResponse: 'false' },
      'legacyResponse: expected boolean',
    );
  });
});

// legacyResponse:false calls resolveTargetContext even for inline inputs, so it
// cannot be exercised here with only repository resolution mocked.
// gn_audit_diff requires loadStateReport and two persisted projected sessions;
// it has no inline input mode and is intentionally outside this fixture.
