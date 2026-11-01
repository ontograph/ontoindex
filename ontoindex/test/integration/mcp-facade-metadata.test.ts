import { describe, expect, it, vi } from 'vitest';

import { dispatchFacade } from '../../src/mcp/facade/dispatch.js';
import { ONTOINDEX_FACADE_TOOLS } from '../../src/mcp/facade/tool-definitions.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { gnHelp } from '../../src/mcp/super/help.js';
import * as superDispatch from '../../src/mcp/super/dispatch.js';

describe('MCP Facade Metadata Integration', () => {
  it.each([
    { action: 'replace', method: 'replace_symbol', fields: { new_body: '', dry_run: true } },
    {
      action: 'replace',
      method: 'replace_symbol',
      fields: { new_body: 'return 2;', confirm: true },
    },
    { action: 'rename', method: 'rename', fields: { new_name: 'renamed', dry_run: true } },
    { action: 'rename', method: 'rename', fields: { new_name: 'renamed' } },
  ])(
    'forwards advertised $action fields without adding defaults',
    async ({ action, method, fields }) => {
      const backend = { callTool: vi.fn(async () => ({ success: true })) };
      const target = 'Function:source.ts:target';
      const args = { target, ...fields };
      const original = structuredClone(args);
      await dispatchFacade('refactor', action, args, backend as unknown as LocalBackend);
      expect(backend.callTool).toHaveBeenCalledExactlyOnceWith(method, {
        ...args,
        ...(action === 'replace' ? { uid: target } : { symbol_uid: target }),
      });
      expect(args).toEqual(original);
    },
  );

  it('keeps safe_refactor camelCase options independent of replacement preview defaults', async () => {
    const dispatch = vi.spyOn(superDispatch, 'dispatchSuper').mockResolvedValue({ applied: false });
    const backend = {
      resolveRepo: vi.fn(async () => ({ id: 'fixture', repoPath: '/tmp/fixture' })),
      ensureRepoInitialized: vi.fn(async () => {}),
      callTool: vi.fn(),
    };
    const args = {
      intent: 'modify-body',
      symbol: 'Function:source.ts:target',
      params: { newBody: '' },
      dryRun: true,
      preChecks: false,
    };
    try {
      await dispatchFacade('refactor', 'safe_refactor', args, backend as unknown as LocalBackend);
      expect(dispatch).toHaveBeenCalledExactlyOnceWith('gn_safe_refactor', args, 'fixture', {
        repoPath: '/tmp/fixture',
        callTool: expect.any(Function),
      });
      expect(dispatch.mock.calls[0][1]).not.toHaveProperty('dry_run');
      expect(dispatch.mock.calls[0][1]).not.toHaveProperty('new_body');
    } finally {
      dispatch.mockRestore();
    }
  });

  it('facade search exposes Markdown RAG enrichment opt-ins', () => {
    const searchTool = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'search')!;

    expect(searchTool.inputSchema.required).toEqual(['action']);
    expect(searchTool.inputSchema.properties.consume_enrichment_facts).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(searchTool.inputSchema.properties.retrieval_policy).toMatchObject({
      type: 'string',
      enum: [
        'graph-only',
        'graph-with-passive-docs',
        'requirement-neighborhood',
        'api-route-neighborhood',
        'process-neighborhood',
        'symbol-neighborhood',
      ],
    });
    expect(searchTool.inputSchema.properties.retrieval_policy.enum).not.toContain(
      'api-doc-neighborhood',
    );
    expect(searchTool.inputSchema.properties.include_passive_related_facts).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(searchTool.inputSchema.properties.include_markdown_context).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(searchTool.inputSchema.properties.include_markdown_ppr).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });

  it('facade inspect context exposes Markdown RAG enrichment opt-ins', () => {
    const inspectTool = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'inspect')!;

    expect(inspectTool.inputSchema.properties.consume_enrichment_facts).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(inspectTool.inputSchema.properties.retrieval_policy).toMatchObject({
      type: 'string',
      enum: [
        'graph-only',
        'graph-with-passive-docs',
        'requirement-neighborhood',
        'api-route-neighborhood',
        'process-neighborhood',
        'symbol-neighborhood',
      ],
    });
    expect(inspectTool.inputSchema.properties.retrieval_policy.enum).not.toContain(
      'api-doc-neighborhood',
    );
    expect(inspectTool.inputSchema.properties.neighborhood_mode).toMatchObject({
      type: 'string',
      enum: [
        'symbol-neighborhood',
        'route-neighborhood',
        'process-neighborhood',
        'requirement-neighborhood',
        'api-doc-neighborhood',
      ],
    });
    expect(inspectTool.inputSchema.properties.include_passive_related_facts).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(inspectTool.inputSchema.properties.include_markdown_context).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(inspectTool.inputSchema.properties.include_markdown_ppr).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });

  it('passes facade inspect context Markdown opt-ins through to LocalBackend', async () => {
    const fakeBackend = {
      callTool: vi.fn(async () => ({ ok: true })),
    } as unknown as LocalBackend;

    await dispatchFacade(
      'inspect',
      'context',
      {
        target: 'LocalBackend',
        consume_enrichment_facts: true,
        include_passive_related_facts: true,
        include_markdown_context: true,
        retrieval_policy: 'symbol-neighborhood',
        neighborhood_mode: 'symbol-neighborhood',
        depth: 2,
      },
      fakeBackend,
    );

    expect(fakeBackend.callTool).toHaveBeenCalledWith('context', {
      target: 'LocalBackend',
      name: 'LocalBackend',
      consume_enrichment_facts: true,
      include_passive_related_facts: true,
      include_markdown_context: true,
      retrieval_policy: 'symbol-neighborhood',
      neighborhood_mode: 'symbol-neighborhood',
      depth: 2,
    });
  });

  it('normalizes facade target aliases for inspect and impact actions', async () => {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const fakeBackend = {
      callTool: vi.fn(async (method: string, args: Record<string, unknown>) => {
        calls.push({ method, args });
        return { ok: true };
      }),
    } as unknown as LocalBackend;

    await dispatchFacade('inspect', 'context', { target: 'LocalBackend' }, fakeBackend);
    await dispatchFacade('inspect', 'evidence', { target: 'src/index.ts:1' }, fakeBackend);
    await dispatchFacade('inspect', 'shape', { target: 'GET /api/repos' }, fakeBackend);
    await dispatchFacade('inspect', 'ipc', { target: 'writeGraphCsv' }, fakeBackend);
    await dispatchFacade('impact', 'symbol', { target: 'runAnalyze' }, fakeBackend);
    await dispatchFacade('impact', 'batch', { target: 'runAnalyze' }, fakeBackend);
    await dispatchFacade('impact', 'route', { target: 'GET /api/repos' }, fakeBackend);

    expect(calls).toEqual([
      { method: 'context', args: { target: 'LocalBackend', name: 'LocalBackend' } },
      { method: 'evidence_pack', args: { target: 'src/index.ts:1', targets: ['src/index.ts:1'] } },
      { method: 'shape_check', args: { target: 'GET /api/repos', route: 'GET /api/repos' } },
      { method: 'ipc_trace', args: { target: 'writeGraphCsv', symbol_name: 'writeGraphCsv' } },
      { method: 'impact', args: { target: 'runAnalyze', direction: 'upstream' } },
      { method: 'impact_batch', args: { target: 'runAnalyze', targets: ['runAnalyze'] } },
      { method: 'api_impact', args: { target: 'GET /api/repos', route: 'GET /api/repos' } },
    ]);
  });

  it('facade docs exposes typed docs actions without raw docs graph query', () => {
    const docsTool = ONTOINDEX_FACADE_TOOLS.find((tool) => tool.name === 'docs')!;

    expect(docsTool.inputSchema.properties.action).toMatchObject({
      enum: ['trace', 'drift', 'context', 'readiness'],
    });
    expect(docsTool.inputSchema.properties.action.enum).not.toContain('graph_query');
    expect(docsTool.inputSchema.properties.maxItems).toMatchObject({
      default: 25,
      maximum: 100,
    });
    expect(docsTool.inputSchema.properties.limit).toMatchObject({
      default: 25,
      maximum: 100,
    });
  });

  it('routes facade docs requests to the bounded docs adapter', async () => {
    const fakeBackend = {
      callTool: vi.fn(async () => ({ ok: true })),
    } as unknown as LocalBackend;

    await dispatchFacade('docs', 'trace', { id: 'REQ-1', maxItems: 5 }, fakeBackend);

    expect(fakeBackend.callTool).toHaveBeenCalledWith('docs', {
      action: 'trace',
      id: 'REQ-1',
      maxItems: 5,
    });
  });

  it('answers setup/help and edit-readiness prompts from the compact help report', () => {
    const prompts = gnHelp().ergonomicsReview.workflowPrompts;

    expect(prompts.setupHelp).toContain('discover({action: "tools"})');
    expect(prompts.editReadiness).toContain('gn_safe_edit_check');
  });
});
