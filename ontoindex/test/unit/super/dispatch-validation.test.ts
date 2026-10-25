import { describe, expect, it, vi } from 'vitest';
import { dispatchFacade } from '../../../src/mcp/facade/dispatch.js';
import type { LocalBackend } from '../../../src/mcp/local/local-backend.js';
import {
  dispatchSuper,
  validateSuperParams,
  type SuperTool,
} from '../../../src/mcp/super/dispatch.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../../src/mcp/super/tool-definitions.js';

vi.mock('../../../src/mcp/super/audit-ingest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/mcp/super/audit-ingest.js')>()),
  resolveAuditRepoHandle: async () => ({ id: 'fixture', repoPath: '/tmp/marker-scan-fixture' }),
}));

describe('audit marker scan dispatch parity', () => {
  it.each([
    {
      name: 'prefers sourceText over source and finds TODO with default windows',
      params: {
        sourceText: '// TODO: revisit\nconst value = 1;\n// clean',
        source: '// clean\nconst value = 1;\n// clean',
        evidenceLine: 2,
      },
      suggestedStatus: 'HOLD',
      markerCount: 1,
      before: 3,
      after: 3,
      startLine: 1,
      endLine: 3,
    },
    {
      name: 'honors explicit zero windows instead of applying defaults',
      params: {
        source: '// TODO: revisit\nconst value = 1;\n// clean',
        evidenceLine: 2,
        windowBefore: 0,
        windowAfter: 0,
      },
      suggestedStatus: 'NEEDS-VERIFY',
      markerCount: 0,
      before: 0,
      after: 0,
      startLine: 2,
      endLine: 2,
    },
    {
      name: 'returns no markers for clean source with default windows',
      params: { source: '// clean\nconst value = 1;\n// clean', evidenceLine: 2 },
      suggestedStatus: 'NEEDS-VERIFY',
      markerCount: 0,
      before: 3,
      after: 3,
      startLine: 1,
      endLine: 3,
    },
  ])('$name', async ({ params, suggestedStatus, markerCount, ...window }) => {
    const args = Object.freeze({ ...params, path: 'fixture.ts' });
    const original = { ...args };
    const backend = {
      resolveRepo: async () => ({ id: 'fixture', repoPath: '/tmp/marker-scan-fixture' }),
    } as unknown as LocalBackend;
    const direct = (await dispatchSuper(
      'gn_audit_pr_marker_scan',
      args,
      'fixture',
    )) as Record<string, unknown>;
    const facade = await dispatchFacade('audit', 'pr_marker_scan', args, backend);

    expect(direct).toMatchObject({
      action: 'audit-pr-marker-scan',
      suggestedStatus,
      evidenceWindow: {
        before: window.before,
        after: window.after,
        startLine: window.startLine,
        endLine: window.endLine,
      },
    });
    expect(direct.markers).toHaveLength(markerCount);
    if (markerCount > 0) {
      expect(direct.markers).toMatchObject([{ markerKind: 'TODO', line: 1 }]);
    }
    expect(facade).toMatchObject(direct);
    expect(args).toEqual(original);
  });
});

describe('super argument validation', () => {
  it('accepts session aliases without changing conflicting values', () => {
    for (const params of [{ session: 'a' }, { sessionId: 'b' }, { session: 'a', sessionId: 'b' }]) {
      Object.freeze(params);
      expect(() => validateSuperParams('gn_audit_bundle', params)).not.toThrow();
    }
    expect(() => validateSuperParams('gn_audit_bundle', {})).toThrow('Required');
  });
  it('validates array item types and enums', () => {
    expect(() => validateSuperParams('gn_path_verify', { when: 'x', must: [1] })).toThrow(
      'must[0]',
    );
    expect(() =>
      validateSuperParams('gn_ensure_fresh', { requiredGraphCapabilities: ['invalid'] }),
    ).toThrow('requiredGraphCapabilities[0]');
  });
  it('enforces declared array bounds without modifying inputs', () => {
    const property = ONTOINDEX_SUPER_TOOLS.find((tool) => tool.name === 'gn_path_verify')!
      .inputSchema.properties.must;
    const original = { ...property };
    try {
      Object.assign(property, { minItems: 1, maxItems: 2 });
      expect(() => validateSuperParams('gn_path_verify', { when: 'x', must: [] })).toThrow(
        'minItems',
      );
      expect(() =>
        validateSuperParams('gn_path_verify', { when: 'x', must: ['a', 'b', 'c'] }),
      ).toThrow('maxItems');
      const params = Object.freeze({ when: 'x', must: Object.freeze(['a']) });
      expect(() => validateSuperParams('gn_path_verify', params)).not.toThrow();
    } finally {
      delete property.minItems;
      delete property.maxItems;
      Object.assign(property, original);
    }
  });
  it('rejects string boolean before analysis submission', async () => {
    await expect(
      dispatchSuper('gn_ensure_fresh', { autoAnalyze: 'false' }, 'missing'),
    ).rejects.toThrow('Invalid arguments for gn_ensure_fresh: autoAnalyze:');
  });
  it.each([
    ['module', 'gn_explain_module', {}, 'filePath'],
    ['module', 'gn_explain_module', { filePath: 1 }, 'filePath'],
    ['module', 'gn_explain_module', { filePath: 'x', recentTouchDays: 'bad' }, 'recentTouchDays'],
    ['related', 'gn_find_related', {}, 'symbol'],
    ['related', 'gn_find_related', { symbol: 1 }, 'symbol'],
    ['related', 'gn_find_related', { symbol: 'x', maxItemsPerCategory: 'bad' }, 'maxItemsPerCategory'],
  ] as const)(
    'rejects invalid inspect/%s arguments through both dispatchers: %j',
    async (action, name, params, field) => {
      const backend = {
        resolveRepo: async () => ({ id: 'fixture' }),
        ensureRepoInitialized: vi.fn(async () => {}),
        withPreparedRepoRead: vi.fn(async (_repo, _options, operation) => operation()),
      } as unknown as LocalBackend;
      const expected = `Invalid arguments for ${name}: ${field}:`;
      await expect(dispatchSuper(name, params, 'fixture')).rejects.toThrow(expected);
      await expect(dispatchFacade('inspect', action, params, backend)).rejects.toThrow(expected);
    },
  );
  it.each([
    [{}, 'symbol: Required'],
    [{ symbol: 1 }, 'symbol: expected string'],
    [{ symbol: 'parseToken', intent: 'invalid' }, 'intent: expected one of'],
    [{ symbol: 'parseToken', force: 'false' }, 'force: expected boolean'],
    [{ symbol: 'parseToken', docsEvidence: 'false' }, 'docsEvidence: expected boolean'],
    [{ symbol: 'parseToken', legacyResponse: 'false' }, 'legacyResponse: expected boolean'],
  ] as const)('rejects invalid audit/safe_edit_check arguments through both dispatchers: %j', async (params, issue) => {
    const callTool = vi.fn();
    const backend = {
      resolveRepo: async () => ({ id: 'fixture' }),
      ensureRepoInitialized: vi.fn(async () => {}),
      withPreparedRepoRead: vi.fn(async (_repo, _options, operation) => operation()),
      callTool,
    } as unknown as LocalBackend;
    const expected = `Invalid arguments for gn_safe_edit_check: ${issue}`;
    await expect(dispatchSuper('gn_safe_edit_check', params, 'fixture')).rejects.toThrow(expected);
    await expect(dispatchFacade('audit', 'safe_edit_check', params, backend)).rejects.toThrow(expected);
    expect(callTool).not.toHaveBeenCalled();
  });
  it.each([
    ['dedupe', 'gn_audit_dedupe', {}, 'session or sessionId: Required'],
    ['dedupe', 'gn_audit_dedupe', { sessionId: 1 }, 'sessionId: expected string'],
    ['dedupe', 'gn_audit_dedupe', { session: 'a', strategy: 'invalid' }, 'strategy: expected one of'],
    ['bundle', 'gn_audit_bundle', {}, 'session or sessionId: Required'],
    ['bundle', 'gn_audit_bundle', { sessionId: 1 }, 'sessionId: expected string'],
    ['bundle', 'gn_audit_bundle', { session: 'a', strategy: 'invalid' }, 'strategy: expected one of'],
    ['bundle', 'gn_audit_bundle', { session: 'a', persist: 'false' }, 'persist: expected boolean'],
    ['dispatch_prompt', 'gn_dispatch_prompt', {}, 'session or sessionId: Required'],
    ['dispatch_prompt', 'gn_dispatch_prompt', { sessionId: 1 }, 'sessionId: expected string'],
    ['dispatch_prompt', 'gn_dispatch_prompt', { session: 'a', bundleId: 1 }, 'bundleId: expected string'],
    ['dispatch_prompt', 'gn_dispatch_prompt', { session: 'a', redactionMode: 'invalid' }, 'redactionMode: expected one of'],
    ['dispatch_prompt', 'gn_dispatch_prompt', { session: 'a', forbidUnverifiedFindings: 'false' }, 'forbidUnverifiedFindings: expected boolean'],
    ['dispatch_prompt', 'gn_dispatch_prompt', { session: 'a', allowRuntimeOnlyFindings: 'false' }, 'allowRuntimeOnlyFindings: expected boolean'],
    ['dispatch_prompt', 'gn_dispatch_prompt', { session: 'a', persist: 'false' }, 'persist: expected boolean'],
    ['diff', 'gn_audit_diff', { sessionB: 'b' }, 'sessionA: Required'],
    ['diff', 'gn_audit_diff', { sessionA: 'a' }, 'sessionB: Required'],
    ['diff', 'gn_audit_diff', { sessionA: 1, sessionB: 'b' }, 'sessionA: expected string'],
    ['diff', 'gn_audit_diff', { sessionA: 'a', sessionB: 1 }, 'sessionB: expected string'],
    ['export', 'gn_audit_export', {}, 'session or sessionId: Required'],
    ['export', 'gn_audit_export', { sessionId: 1 }, 'sessionId: expected string'],
    ['export', 'gn_audit_export', { session: 'a', format: 'invalid' }, 'format: expected one of'],
    ['replay', 'gn_audit_replay', {}, 'session or sessionId: Required'],
    ['replay', 'gn_audit_replay', { sessionId: 1 }, 'sessionId: expected string'],
    ['replay', 'gn_audit_replay', { session: 'a', targetHead: 1 }, 'targetHead: expected string'],
    ['fix_history', 'gn_fix_history', { path: 'fixture.ts' }, 'targetHead: Required'],
    ['fix_history', 'gn_fix_history', { targetHead: 'HEAD' }, 'path: Required'],
    ['fix_history', 'gn_fix_history', { targetHead: 1, path: 'fixture.ts' }, 'targetHead: expected string'],
    ['fix_history', 'gn_fix_history', { targetHead: 'HEAD', path: 1 }, 'path: expected string'],
    ['fix_history', 'gn_fix_history', { targetHead: 'HEAD', path: 'fixture.ts', patterns: 'fix' }, 'patterns: expected array'],
    ['fix_history', 'gn_fix_history', { targetHead: 'HEAD', path: 'fixture.ts', patterns: [1] }, 'patterns[0]: expected string'],
    ['pr_marker_scan', 'gn_audit_pr_marker_scan', {}, 'evidenceLine: Required'],
    ['pr_marker_scan', 'gn_audit_pr_marker_scan', { evidenceLine: '1' }, 'evidenceLine: expected number'],
    ['pr_marker_scan', 'gn_audit_pr_marker_scan', { evidenceLine: NaN }, 'evidenceLine: expected number'],
    ['pr_marker_scan', 'gn_audit_pr_marker_scan', { evidenceLine: Infinity }, 'evidenceLine: expected number'],
    ['pr_marker_scan', 'gn_audit_pr_marker_scan', { evidenceLine: 1, sourceText: 1 }, 'sourceText: expected string'],
    ['lint', 'gn_audit_lint', { scope: 'invalid' }, 'scope: expected one of'],
    ['lint', 'gn_audit_lint', { cursor: 1 }, 'cursor: expected string'],
    ['lint', 'gn_audit_lint', { session: 1 }, 'session: expected string'],
    ['lint', 'gn_audit_lint', { sessionId: 1 }, 'sessionId: expected string'],
    ['lint', 'gn_audit_lint', { advisory: 'false' }, 'advisory: expected boolean'],
    ['lint', 'gn_audit_lint', { summary: 'false' }, 'summary: expected boolean'],
    ['lint', 'gn_audit_lint', { minimal: 'false' }, 'minimal: expected boolean'],
    ['lint', 'gn_audit_lint', { includeIgnored: 'false' }, 'includeIgnored: expected boolean'],
    ['lint', 'gn_audit_lint', { persist: 'false' }, 'persist: expected boolean'],
  ] as const)(
    'rejects invalid audit/%s arguments through both dispatchers: %j',
    async (action, name, params, issue) => {
      const backend = {
        resolveRepo: async () => ({ id: 'fixture' }),
      } as unknown as LocalBackend;
      const expected = `Invalid arguments for ${name}: ${issue}`;
      await expect(dispatchSuper(name, params, 'fixture')).rejects.toThrow(expected);
      await expect(dispatchFacade('audit', action, params, backend)).rejects.toThrow(expected);
    },
  );
  for (const [action, name, params, field] of [
    ['dedupe', 'gn_audit_dedupe', { sessionId: 'a' }, 'maxGroups'],
    ['bundle', 'gn_audit_bundle', { sessionId: 'a' }, 'maxBundles'],
    ['dispatch_prompt', 'gn_dispatch_prompt', { sessionId: 'a' }, 'maxPromptChars'],
    ['diff', 'gn_audit_diff', { sessionA: 'a', sessionB: 'b' }, 'maxEntries'],
    ['export', 'gn_audit_export', { sessionId: 'a' }, 'maxFindings'],
    ['replay', 'gn_audit_replay', { sessionId: 'a' }, 'maxFindings'],
    ['fix_history', 'gn_fix_history', { targetHead: 'HEAD', path: 'fixture.ts' }, 'limit'],
    ['pr_marker_scan', 'gn_audit_pr_marker_scan', { evidenceLine: 1 }, 'windowBefore'],
    ['pr_marker_scan', 'gn_audit_pr_marker_scan', { evidenceLine: 1 }, 'windowAfter'],
    ['lint', 'gn_audit_lint', {}, 'maxIssues'],
  ] as const) {
    it.each(['invalid', null, NaN, Infinity])(
      `rejects invalid audit/${action} ${field} through both dispatchers: %j`,
      async (value) => {
        const backend = {
          resolveRepo: async () => ({ id: 'fixture' }),
        } as unknown as LocalBackend;
        const args = { ...params, [field]: value };
        const expected = `Invalid arguments for ${name}: ${field}: expected number`;
        await expect(dispatchSuper(name, args, 'fixture')).rejects.toThrow(expected);
        await expect(dispatchFacade('audit', action, args, backend)).rejects.toThrow(expected);
      },
    );
  }
  for (const field of ['maxSteps', 'maxFrontier', 'maxExpansionPerStep'] as const) {
    it.each(['invalid', null, NaN, Infinity, 0.5])(
      `rejects invalid graph-walk ${field} through both dispatchers: %j`,
      async (value) => {
        const backend = {
          resolveRepo: async () => ({ id: 'fixture' }),
          ensureRepoInitialized: vi.fn(async () => {}),
          withPreparedRepoRead: vi.fn(async (_repo, _options, operation) => operation()),
        } as unknown as LocalBackend;
        const expected = `Invalid arguments for gn_graph_walk: ${field}:`;
        await expect(
          dispatchSuper(
            'gn_graph_walk',
            { action: 'status', walkId: 'fixture', [field]: value },
            'fixture',
          ),
        ).rejects.toThrow(expected);
        await expect(
          dispatchFacade(
            'inspect',
            'graph_walk',
            { walk_action: 'status', walkId: 'fixture', [field]: value },
            backend,
          ),
        ).rejects.toThrow(expected);
      },
    );
  }
  it.each([
    ['gn_explore', { query: 5 }, 'query'],
    ['gn_quality_mode', { level: 'invalid' }, 'level'],
    ['gn_explore', {}, 'query'],
  ] as const)('rejects malformed %s arguments', (name, params, field) => {
    expect(() => validateSuperParams(name, params)).toThrow(
      `Invalid arguments for ${name}: ${field}:`,
    );
  });
  it('allows unknown properties and preserves omitted defaults', () => {
    const params = { query: 'x', extra: { retained: true } };
    validateSuperParams('gn_explore', params);
    expect(params).toEqual({ query: 'x', extra: { retained: true } });
  });
  it.each([
    ['gn_taint_trace', { source: 'input', sink: 'output' }],
    ['gn_taint_trace', { sourceName: 'input', sinkName: 'output' }],
    ['gn_taint_trace', { source: 'input', sinkName: 'output' }],
    ['gn_taint_trace', { sourceName: 'input', sink: 'output' }],
    ['gn_simulate_fault', { target: 'call' }],
    ['gn_simulate_fault', { targetCall: 'call' }],
  ] as const)('accepts canonical and alias arguments for %s', (name, params) => {
    expect(() => validateSuperParams(name, params)).not.toThrow();
  });
  it.each([
    ['gn_taint_trace', {}, 'source or sourceName: Required'],
    ['gn_taint_trace', { sourceName: 'input' }, 'sink or sinkName: Required'],
    ['gn_taint_trace', { sinkName: 'output' }, 'source or sourceName: Required'],
    ['gn_simulate_fault', {}, 'target or targetCall: Required'],
  ] as const)('rejects missing argument families for %s', (name, params, issue) => {
    expect(() => validateSuperParams(name, params)).toThrow(issue);
  });
  it.each([
    [
      'gn_taint_trace',
      {
        source: 'canonical',
        sourceName: 'alias',
        sink: 'canonical',
        sinkName: 'alias',
        extra: 'retained',
      },
    ],
    ['gn_simulate_fault', { target: 'canonical', targetCall: 'alias', extra: 'retained' }],
  ] as const)('preserves conflicting arguments for %s', (name, params) => {
    const original = { ...params };
    Object.freeze(params);
    expect(() => validateSuperParams(name, params)).not.toThrow();
    expect(params).toEqual(original);
  });
  for (const [name, params, fields] of [
    [
      'gn_taint_trace',
      { source: 'input', sourceName: 'input', sink: 'output', sinkName: 'output' },
      ['source', 'sourceName', 'sink', 'sinkName'],
    ],
    ['gn_simulate_fault', { target: 'call', targetCall: 'call' }, ['target', 'targetCall']],
  ] as const) {
    for (const field of fields) {
      it.each([undefined, null, 1, false, [], {}])(
        `rejects invalid ${name}.${field} even when its other name is valid: %j`,
        (value) => {
          expect(() => validateSuperParams(name, { ...params, [field]: value })).toThrow(
            `${field}: expected string`,
          );
        },
      );
    }
  }
  for (const tool of ONTOINDEX_SUPER_TOOLS) {
    it(`accepts required advertised inputs for ${tool.name}`, () => {
      const params: Record<string, unknown> = {};
      const requiredKeys = [
        ...tool.inputSchema.required,
        ...(tool.inputSchema.anyOf?.[0]?.required ?? []),
        ...(tool.inputSchema.allOf?.flatMap((clause) => clause.anyOf[0]?.required ?? []) ?? []),
      ];
      for (const key of requiredKeys) {
        const property = tool.inputSchema.properties[key];
        const type = Array.isArray(property.type) ? property.type[0] : property.type;
        params[key] =
          property.enum?.[0] ??
          (
            {
              string: 'sample',
              number: 1,
              integer: 1,
              boolean: true,
              array: [],
              object: {},
              null: null,
            } as Record<string, unknown>
          )[type];
      }
      expect(() => validateSuperParams(tool.name as SuperTool, params)).not.toThrow();
    });
    if (
      tool.inputSchema.required.includes('session') &&
      Object.hasOwn(tool.inputSchema.properties, 'sessionId')
    ) {
      it(`accepts sessionId alias without mutating inputs for ${tool.name}`, () => {
        const params: Record<string, unknown> = { sessionId: 'sample' };
        for (const key of tool.inputSchema.required) {
          if (key !== 'session') params[key] = 'sample';
        }
        const original = { ...params };
        expect(() => validateSuperParams(tool.name as SuperTool, params)).not.toThrow();
        expect(params).toEqual(original);
        const { sessionId: _sessionId, ...missing } = params;
        expect(() => validateSuperParams(tool.name as SuperTool, missing)).toThrow(
          'session: Required',
        );
        expect(() =>
          validateSuperParams(tool.name as SuperTool, { ...params, sessionId: 1 }),
        ).toThrow('sessionId: expected string');
        expect(() =>
          validateSuperParams(tool.name as SuperTool, { ...params, session: 1 }),
        ).toThrow('session: expected string');
        expect(() =>
          validateSuperParams(tool.name as SuperTool, {
            ...params,
            session: 'canonical',
            sessionId: 1,
          }),
        ).toThrow('sessionId: expected string');
      });
    }
  }
});
