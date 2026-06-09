/**
 * Unit tests for gn_help super-function (Phase 5 W5a).
 *
 * gnHelp is a pure static-data function with no external dependencies,
 * so no mocks are required.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { SUPER_NAMES } from '../../../src/mcp/super/dispatch.js';
import { gnHelp } from '../../../src/mcp/super/help.js';
import { gnToolContract } from '../../../src/mcp/super/tool-contract.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../../src/mcp/super/tool-definitions.js';
import { ALL_AGENT_MODES, getPublicToolRegistry } from '../../../src/mcp/shared/tool-registry.js';

const ORIGINAL_STARTUP_PROFILE = process.env.ONTOINDEX_MCP_STARTUP_PROFILE;

afterEach(() => {
  if (ORIGINAL_STARTUP_PROFILE === undefined) {
    delete process.env.ONTOINDEX_MCP_STARTUP_PROFILE;
  } else {
    process.env.ONTOINDEX_MCP_STARTUP_PROFILE = ORIGINAL_STARTUP_PROFILE;
  }
});

describe('gnHelp — return shape', () => {
  it('returns version: 1', () => {
    const report = gnHelp();
    expect(report.version).toBe(1);
  });

  it('returns all registered super-functions including audit and systems-audit ergonomics', () => {
    const report = gnHelp();
    expect(report.superFunctions).toHaveLength(ONTOINDEX_SUPER_TOOLS.length);
  });

  it('all categories are represented', () => {
    const report = gnHelp();
    const categories = new Set(report.superFunctions.map((sf) => sf.category));
    expect(categories).toContain('discovery');
    expect(categories).toContain('docs');
    expect(categories).toContain('audit');
    expect(categories).toContain('systems-audit');
    expect(categories).toContain('safety');
    expect(categories).toContain('refactor');
    expect(categories).toContain('lifecycle');
    expect(categories).toContain('pr-review');
    expect(categories).toContain('self-help');
  });

  it('recommendedWorkflow is a non-empty array', () => {
    const report = gnHelp();
    expect(Array.isArray(report.recommendedWorkflow)).toBe(true);
    expect(report.recommendedWorkflow.length).toBeGreaterThan(0);
  });

  it('returns the capability-aware envelope when legacyResponse is false', () => {
    const report = gnHelp({ legacyResponse: false });

    expect(report).toMatchObject({
      envelopeVersion: '1',
      tool: 'gn_help',
      status: 'ok',
      targetContext: { scope: 'global' },
      capabilitiesUsed: ['tool-registry'],
      nextTools: expect.arrayContaining(['gn_quality_mode', 'gn_explore', 'gn_diagnose']),
    });
    expect((report.results as Record<string, unknown>).superFunctions).toBeDefined();
  });

  it('exposes deterministic evidence-gap next steps', () => {
    const report = gnHelp();

    expect(report.evidenceExpansion).toMatchObject({
      evidenceGaps: ['stale_index', 'tool_contract_drift', 'docs_only_code_behavior_claim'],
      nextTools: ['gn_ensure_fresh', 'gn_tool_contract'],
      nonToolActions: ['fix_registry_drift', 'verify_graph_or_code_evidence'],
      issues: [],
      validation: {
        callableToolSource: 'public-tool-registry',
        publicCallable: true,
      },
    });
    expect(report.evidenceExpansion.nextSteps.map((step) => step.condition)).toEqual([
      'stale_index',
      'tool_contract_drift',
      'tool_contract_drift',
      'docs_only_code_behavior_claim',
    ]);
  });

  it('validates evidence-gap next tools against public callable tools', () => {
    const report = gnHelp();
    const publicCallableTools = new Set(
      getPublicToolRegistry({ includeFacades: true })
        .filter((entry) => entry.callable)
        .map((entry) => entry.name),
    );

    for (const tool of report.evidenceExpansion.nextTools) {
      expect(publicCallableTools.has(tool)).toBe(true);
    }
  });

  it('adds evidence-gap tools to capability envelope nextTools', () => {
    const report = gnHelp({ legacyResponse: false });

    expect(report.nextTools).toEqual(
      expect.arrayContaining([
        'gn_quality_mode',
        'gn_explore',
        'gn_diagnose',
        'gn_ensure_fresh',
        'gn_tool_contract',
      ]),
    );
  });

  it('includes actionable docs and embeddings remediation in repo readiness notes', () => {
    const report = gnHelp({ repo: 'repo:test' });
    expect(report.readinessNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ontoindex docs refresh'),
        expect.stringContaining('ontoindex analyze --markdown-sidecar'),
        expect.stringContaining('ontoindex analyze --embeddings'),
      ]),
    );
  });
});

describe('ADR27: gnHelp startup-profile metadata', () => {
  it('reports public-full as the default compatible startup profile', () => {
    delete process.env.ONTOINDEX_MCP_STARTUP_PROFILE;
    const report = gnHelp();
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
    expect(report.startupProfile.hiddenButCallable).toEqual([]);
  });

  it('reports hidden-but-callable tools for a smaller startup profile', () => {
    process.env.ONTOINDEX_MCP_STARTUP_PROFILE = 'core';
    const report = gnHelp();

    expect(report.startupProfile.activeProfile).toBe('core');
    expect(report.startupProfile.source).toBe('env');
    expect(report.startupProfile.advertised).toContain('gn_help');
    expect(report.startupProfile.advertised).toContain('search');
    expect(report.startupProfile.hiddenButCallable).toContain('gn_audit_ingest');
    expect(report.startupProfile.hiddenButCallableCount).toBe(
      report.startupProfile.hiddenButCallable.length,
    );
    expect(report.startupProfile.hiddenButCallableCount).toBeGreaterThan(0);
    expect(report.startupProfile.advertisedCount).toBeLessThan(
      report.startupProfile.fullPublicCount,
    );
    expect(report.startupProfile.compatibilityMode).toBe(true);
  });

  it('falls back to public-full for an unknown startup profile value', () => {
    process.env.ONTOINDEX_MCP_STARTUP_PROFILE = 'full';
    const report = gnHelp();

    expect(report.startupProfile).toMatchObject({
      activeProfile: 'public-full',
      source: 'env-invalid-default',
      invalidProfile: 'full',
      hiddenButCallableCount: 0,
    });
  });
});

describe('gnHelp — super-function entries', () => {
  it('gn_help is listed in superFunctions', () => {
    const report = gnHelp();
    const names = report.superFunctions.map((sf) => sf.name);
    expect(names).toContain('gn_help');
    expect(names).toContain('gn_tool_contract');
    expect(names).toContain('gn_audit_ingest');
    expect(names).toContain('gn_audit_verify');
    expect(names).toContain('gn_audit_lint');
    expect(names).toContain('gn_audit_dedupe');
    expect(names).toContain('gn_dispatch_prompt');
    expect(names).toContain('gn_audit_tombstone_create');
    expect(names).toContain('gn_audit_session_start');
    expect(names).toContain('gn_audit_session_verify');
    expect(names).toContain('gn_audit_session_dedupe');
    expect(names).toContain('gn_audit_session_bundle');
    expect(names).toContain('gn_audit_session_dispatch');
    expect(names).toContain('gn_audit_session_review_worker');
    expect(names).toContain('gn_audit_session_lock');
    expect(names).toContain('gn_audit_pr_marker_scan');
    expect(names).toContain('gn_audit_diff');
    expect(names).toContain('gn_audit_replay');
    expect(names).toContain('gn_audit_export');
    expect(names).toContain('gn_scope_guard');
    expect(names).toContain('gn_bundle_conflicts');
    expect(names).toContain('gn_audit_logic');
    expect(names).toContain('gn_resource_trace');
    expect(names).toContain('gn_path_verify');
    expect(names).toContain('gn_test_suggestions');
    expect(names).toContain('gn_trace_boundary');
    expect(names).toContain('gn_extract_fsm');
    expect(names).toContain('gn_error_topology');
    expect(names).toContain('gn_concurrency_audit');
    expect(names).toContain('gn_pressure_impact');
    expect(names).toContain('gn_taint_trace');
    expect(names).toContain('gn_abi_diff');
    expect(names).toContain('gn_simulate_fault');
  });

  it('every entry has non-empty name, intent, and whenToUse', () => {
    const report = gnHelp();
    for (const sf of report.superFunctions) {
      expect(sf.name.length).toBeGreaterThan(0);
      expect(sf.intent.length).toBeGreaterThan(0);
      expect(sf.whenToUse.length).toBeGreaterThan(0);
    }
  });

  it('limits advisory memory guidance to gn_docs context/readiness help', () => {
    const report = gnHelp();
    const docsEntry = report.superFunctions.find((sf) => sf.name === 'gn_docs');

    expect(docsEntry?.whenToUse).toContain('includeMemories');
    expect(docsEntry?.whenToUse).toContain('context/readiness');
    expect(docsEntry?.whenToUse).toContain('never as trace/drift evidence');
    expect(report.ergonomicsReview.recommendedChanges.join(' ')).toContain(
      'use includeMemories only for advisory context/readiness',
    );
  });

  it('primitivesAsEscapeHatch is a non-empty string', () => {
    const report = gnHelp();
    expect(typeof report.primitivesAsEscapeHatch).toBe('string');
    expect(report.primitivesAsEscapeHatch.length).toBeGreaterThan(0);
  });
});

describe('gnHelp — ergonomics review', () => {
  it('includes the P2-M6 structured review fields', () => {
    const review = gnHelp().ergonomicsReview;

    expect(review.toolCount.superFunctions).toBe(ONTOINDEX_SUPER_TOOLS.length);
    expect(review.setupSteps.length).toBeGreaterThanOrEqual(3);
    expect(review.responseSize).toMatchObject({
      compactByDefault: true,
      defaultDocsItems: 25,
      maxDocsItems: 100,
      stalePartialAmbiguousVisible: true,
    });
    expect(review.schemaClarityNotes.length).toBeGreaterThan(0);
    expect(review.recommendedChanges.length).toBeGreaterThan(0);
  });

  it('documents common agent prompts for docs trace, API drift, edit readiness, and setup/help', () => {
    const prompts = gnHelp().ergonomicsReview.workflowPrompts;

    expect(prompts.docsTrace).toContain('gn_docs({action: "trace"');
    expect(prompts.apiDrift).toContain('gn_docs({action: "drift"})');
    expect(prompts.editReadiness).toContain('gn_safe_edit_check');
    expect(prompts.setupHelp).toContain('gn_help({})');
  });

  it('records Codebase-Memory-style comparison as research only', () => {
    const comparison = gnHelp().ergonomicsReview.codebaseMemoryStyleComparison.join(' ');

    expect(comparison).toContain('Research-only comparison');
    expect(comparison).toContain('No runtime dependency');
  });
});

describe('gnHelp — MCP tool contract', () => {
  it('advertises only registered callable super-functions', () => {
    const helpNames = new Set(gnHelp().superFunctions.map((entry) => entry.name));
    const definitionNames = new Set(ONTOINDEX_SUPER_TOOLS.map((tool) => tool.name));

    expect(helpNames).toEqual(definitionNames);
    for (const name of helpNames) {
      expect(SUPER_NAMES.has(name as never)).toBe(true);
    }
  });

  it('reports a clean public MCP contract', () => {
    const contract = gnToolContract();

    expect(contract.status).toBe('ok');
    expect(contract.runtime).toMatchObject({
      packageName: 'ontoindex',
      superToolCount: ONTOINDEX_SUPER_TOOLS.length,
    });
    expect(contract.missing).toEqual([]);
    expect(contract.extras).toEqual([]);
    expect(contract.advertised).toContain('gn_resource_trace');
    expect(contract.callable).toContain('gn_resource_trace');
  });

  it('documents the legacyResponse opt-in on migrated super tools', () => {
    const migratedTools = ['gn_help', 'gn_diagnose', 'gn_safe_edit_check', 'gn_audit_verify'];

    for (const toolName of migratedTools) {
      const tool = ONTOINDEX_SUPER_TOOLS.find((entry) => entry.name === toolName);
      expect(tool?.inputSchema.properties.legacyResponse).toMatchObject({
        type: 'boolean',
        default: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// SERENA-REV3: mode-aware tool contract
// ---------------------------------------------------------------------------

describe('SERENA-REV3: gnToolContract — structural integrity checks', () => {
  it('always includes structuralChecks in the report', () => {
    const contract = gnToolContract();
    expect(Array.isArray(contract.structuralChecks)).toBe(true);
    expect(contract.structuralChecks.length).toBeGreaterThan(0);
  });

  it('all structural checks pass for the current registry', () => {
    const contract = gnToolContract();
    for (const check of contract.structuralChecks) {
      expect(check.status).toBe('pass');
    }
  });

  it('includes unknown-mode-metadata check', () => {
    const contract = gnToolContract();
    const check = contract.structuralChecks.find((c) => c.check === 'unknown-mode-metadata');
    expect(check).toBeDefined();
    expect(check?.status).toBe('pass');
  });

  it('includes duplicate-aliases check', () => {
    const contract = gnToolContract();
    const check = contract.structuralChecks.find((c) => c.check === 'duplicate-aliases');
    expect(check).toBeDefined();
    expect(check?.status).toBe('pass');
  });

  it('includes min-entrypoints-per-mode check', () => {
    const contract = gnToolContract();
    const check = contract.structuralChecks.find((c) => c.check === 'min-entrypoints-per-mode');
    expect(check).toBeDefined();
    expect(check?.status).toBe('pass');
  });

  it('status remains ok when all checks pass and no drift', () => {
    const contract = gnToolContract();
    expect(contract.status).toBe('ok');
    expect(contract.warnings).toEqual([]);
  });
});

describe('SERENA-REV3: gnToolContract — mode parameter', () => {
  it('mode is absent from report when not supplied', () => {
    const contract = gnToolContract();
    expect(contract.mode).toBeUndefined();
    expect(contract.modeFrontier).toBeUndefined();
  });

  it('includes mode and modeFrontier when mode is supplied', () => {
    const contract = gnToolContract({ mode: 'general' });
    expect(contract.mode).toBe('general');
    expect(contract.modeFrontier).toBeDefined();
    expect(contract.modeFrontier?.mode).toBe('general');
  });

  it.each(ALL_AGENT_MODES)('mode-frontier is ok for mode "%s" in the current registry', (mode) => {
    const contract = gnToolContract({ mode });
    expect(contract.modeFrontier?.status).toBe('ok');
    expect(contract.modeFrontier?.missing).toEqual([]);
    expect(contract.modeFrontier?.extras).toEqual([]);
  });

  it.each(['general', 'audit', 'refactor'] as const)(
    'mode-frontier advertised matches full advertised for write mode "%s"',
    (mode) => {
      const full = gnToolContract();
      const withMode = gnToolContract({ mode });
      // Write modes have all tools, so mode filtering is identity
      expect(withMode.modeFrontier?.advertised).toEqual(full.advertised);
    },
  );

  it('mode-frontier advertised for query-projects is a strict subset of full advertised', () => {
    const full = gnToolContract();
    const withMode = gnToolContract({ mode: 'query-projects' });
    const fullSet = new Set(full.advertised);
    expect(withMode.modeFrontier?.advertised.length).toBeGreaterThan(0);
    expect(withMode.modeFrontier!.advertised.length).toBeLessThan(full.advertised.length);
    for (const name of withMode.modeFrontier!.advertised) {
      expect(fullSet.has(name)).toBe(true);
    }
  });

  it.each(ALL_AGENT_MODES)('mode-frontier callable is non-empty for mode "%s"', (mode) => {
    const contract = gnToolContract({ mode });
    expect(contract.modeFrontier?.callable.length ?? 0).toBeGreaterThan(0);
  });

  it('includeFacades does not create false mode-frontier drift', () => {
    const contract = gnToolContract({ mode: 'audit', includeFacades: true });
    expect(contract.status).toBe('ok');
    expect(contract.modeFrontier?.status).toBe('ok');
    expect(contract.modeFrontier?.missing).toEqual([]);
    expect(contract.modeFrontier?.extras).toEqual([]);
    expect(contract.callable).toEqual(expect.arrayContaining(['audit', 'search', 'docs']));
  });

  it('gn_tool_contract schema exposes mode property including query-projects', () => {
    const schemaTool = ONTOINDEX_SUPER_TOOLS.find((t) => t.name === 'gn_tool_contract');
    expect(schemaTool?.inputSchema.properties.mode).toBeDefined();
    expect(schemaTool?.inputSchema.properties.mode?.type).toBe('string');
    expect(schemaTool?.inputSchema.properties.mode?.enum).toEqual(
      expect.arrayContaining(['general', 'audit', 'refactor', 'query-projects']),
    );
  });
});

describe('SERENA-REV3: gnToolContract — sourceHint on drift items', () => {
  it('missing items include sourceHint field', () => {
    // Validate shape: if missing were non-empty they'd have sourceHint.
    // We verify via the TypeScript type by checking the full contract has no missing.
    const contract = gnToolContract();
    // Contract is clean; missing is empty — verify by shape
    for (const item of contract.missing) {
      expect(typeof item.sourceHint).toBe('string');
      expect(item.sourceHint.length).toBeGreaterThan(0);
    }
  });

  it('extras items include sourceHint field', () => {
    const contract = gnToolContract();
    for (const item of contract.extras) {
      expect(typeof item.sourceHint).toBe('string');
      expect(item.sourceHint.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// REV-4: gn_diff_impact truthfulness and CLI cross-reference
// ---------------------------------------------------------------------------

describe('REV-4: gn_diff_impact — truthful help entry', () => {
  it('gn_diff_impact is categorised as pr-review', () => {
    const report = gnHelp();
    const entry = report.superFunctions.find((sf) => sf.name === 'gn_diff_impact');
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('pr-review');
  });

  it('gn_diff_impact whenToUse clarifies it is an MCP surface', () => {
    const report = gnHelp();
    const entry = report.superFunctions.find((sf) => sf.name === 'gn_diff_impact');
    expect(entry?.whenToUse).toMatch(/MCP/i);
  });

  it('gn_diff_impact whenToUse references the CLI review diff command', () => {
    const report = gnHelp();
    const entry = report.superFunctions.find((sf) => sf.name === 'gn_diff_impact');
    expect(entry?.whenToUse).toContain('ontoindex review diff');
  });

  it('gn_diff_impact whenToUse notes that hosted PR is a later Phase 6 feature', () => {
    const report = gnHelp();
    const entry = report.superFunctions.find((sf) => sf.name === 'gn_diff_impact');
    expect(entry?.whenToUse).toMatch(/phase 6|later/i);
  });

  it('recommendedWorkflow includes the local CLI diff review step', () => {
    const report = gnHelp();
    const workflow = report.recommendedWorkflow.join('\n');
    expect(workflow).toContain('ontoindex review diff');
    expect(workflow).toMatch(/local.only|local-only/i);
  });

  it('recommendedWorkflow mentions that hosted PR adapter is a Phase 6 feature', () => {
    const report = gnHelp();
    const workflow = report.recommendedWorkflow.join('\n');
    expect(workflow).toMatch(/phase 6/i);
  });
});

// ---------------------------------------------------------------------------
// SERENA-REV2: mode-aware help
// ---------------------------------------------------------------------------

describe('SERENA-REV2: mode parameter', () => {
  it('no mode: report has no mode or modeDescription fields', () => {
    const report = gnHelp();
    expect(report.mode).toBeUndefined();
    expect(report.modeDescription).toBeUndefined();
  });

  it('mode=general: report includes mode and modeDescription', () => {
    const report = gnHelp({ mode: 'general' });
    expect(report.mode).toBe('general');
    expect(typeof report.modeDescription).toBe('string');
    expect(report.modeDescription!.length).toBeGreaterThan(0);
  });

  it('mode=audit: report includes mode and modeDescription', () => {
    const report = gnHelp({ mode: 'audit' });
    expect(report.mode).toBe('audit');
    expect(report.modeDescription).toMatch(/audit/i);
  });

  it('mode=refactor: report includes mode and modeDescription', () => {
    const report = gnHelp({ mode: 'refactor' });
    expect(report.mode).toBe('refactor');
    expect(report.modeDescription).toMatch(/refactor/i);
  });

  it('mode=general: recommendedWorkflow is non-empty and does not include audit-manager step', () => {
    const report = gnHelp({ mode: 'general' });
    expect(report.recommendedWorkflow.length).toBeGreaterThan(0);
    const wf = report.recommendedWorkflow.join('\n');
    expect(wf).not.toContain('gn_audit_session_start');
  });

  it('mode=audit: recommendedWorkflow includes manager audit loop', () => {
    const report = gnHelp({ mode: 'audit' });
    const wf = report.recommendedWorkflow.join('\n');
    expect(wf).toContain('gn_audit_session_start');
  });

  it('mode=refactor: recommendedWorkflow includes gn_safe_refactor', () => {
    const report = gnHelp({ mode: 'refactor' });
    const wf = report.recommendedWorkflow.join('\n');
    expect(wf).toContain('gn_safe_refactor');
  });

  it('mode=refactor: recommendedWorkflow does not include audit-session steps', () => {
    const report = gnHelp({ mode: 'refactor' });
    const wf = report.recommendedWorkflow.join('\n');
    expect(wf).not.toContain('gn_audit_session_start');
  });

  it('mode=query-projects: report includes mode and modeDescription mentioning read-only', () => {
    const report = gnHelp({ mode: 'query-projects' });
    expect(report.mode).toBe('query-projects');
    expect(typeof report.modeDescription).toBe('string');
    expect(report.modeDescription).toMatch(/read-only|discovery/i);
  });

  it('mode=query-projects: recommendedWorkflow is non-empty', () => {
    const report = gnHelp({ mode: 'query-projects' });
    expect(report.recommendedWorkflow.length).toBeGreaterThan(0);
  });

  it('mode=query-projects: recommendedWorkflow does not include write tools', () => {
    const report = gnHelp({ mode: 'query-projects' });
    const wf = report.recommendedWorkflow.join('\n');
    expect(wf).not.toContain('gn_safe_edit_check');
    expect(wf).not.toContain('gn_safe_refactor');
    expect(wf).not.toContain('gn_audit_session_start');
    expect(wf).not.toContain('gn_pre_commit_audit');
  });

  it('mode=query-projects: recommendedWorkflow references repo/group discovery', () => {
    const report = gnHelp({ mode: 'query-projects' });
    const wf = report.recommendedWorkflow.join('\n');
    expect(wf).toMatch(/discover|repos|groups/i);
  });

  it('mode=query-projects: superFunctions is a non-empty subset of full list', () => {
    const full = gnHelp();
    const qp = gnHelp({ mode: 'query-projects' });
    expect(qp.superFunctions.length).toBeGreaterThan(0);
    expect(qp.superFunctions.length).toBeLessThan(full.superFunctions.length);
    const fullNames = new Set(full.superFunctions.map((sf) => sf.name));
    for (const sf of qp.superFunctions) {
      expect(fullNames.has(sf.name)).toBe(true);
    }
  });

  it('mode=query-projects: superFunctions contains discovery tools', () => {
    const report = gnHelp({ mode: 'query-projects' });
    const names = report.superFunctions.map((sf) => sf.name);
    expect(names).toContain('gn_explore');
    expect(names).toContain('gn_find_related');
    expect(names).toContain('gn_help');
    expect(names).toContain('gn_diagnose');
  });

  it('mode=query-projects: superFunctions does not contain write/audit tools', () => {
    const report = gnHelp({ mode: 'query-projects' });
    const names = report.superFunctions.map((sf) => sf.name);
    expect(names).not.toContain('gn_safe_edit_check');
    expect(names).not.toContain('gn_safe_refactor');
    expect(names).not.toContain('gn_audit_ingest');
  });

  it('mode-filtered superFunctions still pass every entry having name, intent, whenToUse', () => {
    for (const mode of ['general', 'audit', 'refactor', 'query-projects'] as const) {
      const report = gnHelp({ mode });
      for (const sf of report.superFunctions) {
        expect(sf.name.length).toBeGreaterThan(0);
        expect(sf.intent.length).toBeGreaterThan(0);
        expect(sf.whenToUse.length).toBeGreaterThan(0);
      }
    }
  });

  it('ergonomicsReview.toolCount.superFunctions always reflects the full registered count', () => {
    const full = gnHelp();
    const withMode = gnHelp({ mode: 'audit' });
    expect(withMode.ergonomicsReview.toolCount.superFunctions).toBe(
      full.ergonomicsReview.toolCount.superFunctions,
    );
  });
});

describe('SERENA-REV2: repo readiness notes', () => {
  it('no repo: readinessNotes is absent', () => {
    const report = gnHelp();
    expect(report.readinessNotes).toBeUndefined();
  });

  it('repo supplied: readinessNotes is a non-empty array', () => {
    const report = gnHelp({ repo: 'my-repo' });
    expect(Array.isArray(report.readinessNotes)).toBe(true);
    expect(report.readinessNotes!.length).toBeGreaterThan(0);
  });

  it('readinessNotes mentions gn_diagnose', () => {
    const report = gnHelp({ repo: 'my-repo' });
    const notes = report.readinessNotes!.join('\n');
    expect(notes).toContain('gn_diagnose');
  });

  it('readinessNotes mentions gn_ensure_fresh', () => {
    const report = gnHelp({ repo: 'my-repo' });
    const notes = report.readinessNotes!.join('\n');
    expect(notes).toContain('gn_ensure_fresh');
  });

  it('readinessNotes mentions stale index or dirty worktree guidance', () => {
    const report = gnHelp({ repo: 'my-repo' });
    const notes = report.readinessNotes!.join('\n');
    expect(notes).toMatch(/stale|dirty|worktree|embeddings/i);
  });

  it('repo + mode: both readinessNotes and mode fields are present', () => {
    const report = gnHelp({ repo: 'my-repo', mode: 'audit' });
    expect(report.mode).toBe('audit');
    expect(Array.isArray(report.readinessNotes)).toBe(true);
  });
});

describe('SERENA-REV2: tool definition has mode and repo', () => {
  it('gn_help tool definition includes mode property', () => {
    const tool = ONTOINDEX_SUPER_TOOLS.find((t) => t.name === 'gn_help');
    expect(tool?.inputSchema.properties.mode).toBeDefined();
    expect(tool?.inputSchema.properties.mode?.type).toBe('string');
  });

  it('gn_help tool definition includes repo property', () => {
    const tool = ONTOINDEX_SUPER_TOOLS.find((t) => t.name === 'gn_help');
    expect(tool?.inputSchema.properties.repo).toBeDefined();
    expect(tool?.inputSchema.properties.repo?.type).toBe('string');
  });
});

describe('ADR26: classification-aware gn_help filters', () => {
  it('supports query-driven intent routing', () => {
    const report = gnHelp({ query: 'rename symbol safely', mode: 'refactor' });
    const names = report.superFunctions.map((entry) => entry.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('gn_safe_edit_check');
    expect(names).toContain('gn_safe_refactor');
    expect(report.appliedFilters?.query).toBe('rename symbol safely');
  });

  it('supports evidence-class filtering', () => {
    const report = gnHelp({ evidenceClass: 'audit_evidence' });
    expect(report.superFunctions.length).toBeGreaterThan(0);
    for (const entry of report.superFunctions) {
      expect(entry.producesEvidenceClasses).toContain('audit_evidence');
    }
  });

  it('keeps advisory/diagnostic evidence non-authoritative by default', () => {
    const defaultReport = gnHelp({ evidenceClass: 'advisory_memory' });
    expect(defaultReport.superFunctions).toEqual([]);

    const optedIn = gnHelp({
      evidenceClass: 'advisory_memory',
      includeNonAuthoritativeEvidence: true,
    });
    expect(optedIn.superFunctions.map((entry) => entry.name)).toContain('gn_docs');
  });

  it('supports stability filtering', () => {
    const report = gnHelp({ stability: 'stable' });
    expect(report.superFunctions.length).toBeGreaterThan(0);
    expect(report.superFunctions.every((entry) => entry.contractStatus === 'stable')).toBe(true);
  });
});
