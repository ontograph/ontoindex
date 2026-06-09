/**
 * Unit tests for SERENA-REV1: AgentMode / registry metadata additions to
 * tool-registry.ts.
 *
 * Validates:
 * 1. Static registry parity — no modes-based filtering changes the unfiltered result.
 * 2. Mode-filtered helpers return consistent, non-empty subsets.
 * 3. Backend fallback actions are NOT part of public discovery.
 * 4. New type exports exist and are structurally correct.
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_AGENT_MODES,
  DEFAULT_MCP_STARTUP_PROFILE,
  MCP_STARTUP_PROFILE_ENV,
  BACKEND_FALLBACK_ACTION_NAMES,
  QUERY_PROJECTS_TOOL_NAMES,
  getCallableToolNames,
  getHiddenStartupProfileToolNames,
  getMcpStartupProfileFromEnv,
  getMcpStartupProfileToolReport,
  getPublicToolRegistry,
  getPublicToolDefinitions,
  getRegisteredFacadeToolNames,
  getRegisteredSuperToolNames,
  getToolModes,
  isToolDiscoverableInMode,
  isRepoOptionalSuperToolName,
  parseMcpStartupProfile,
} from '../../../src/mcp/shared/tool-registry.js';
import { ONTOINDEX_SUPER_TOOLS } from '../../../src/mcp/super/tool-definitions.js';
import { ONTOINDEX_FACADE_TOOLS } from '../../../src/mcp/facade/tool-definitions.js';

// ---------------------------------------------------------------------------
// 1. Static registry parity — unfiltered behavior must not change
// ---------------------------------------------------------------------------

describe('tool-registry — static parity (SERENA-REV1)', () => {
  it('getPublicToolRegistry() with no options returns all super + facade tools', () => {
    const registry = getPublicToolRegistry();
    const superCount = ONTOINDEX_SUPER_TOOLS.length;
    const facadeCount = ONTOINDEX_FACADE_TOOLS.length;
    expect(registry).toHaveLength(superCount + facadeCount);
  });

  it('getPublicToolRegistry({ includeFacades: false }) returns only super tools', () => {
    const registry = getPublicToolRegistry({ includeFacades: false });
    expect(registry).toHaveLength(ONTOINDEX_SUPER_TOOLS.length);
    expect(registry.every((e) => e.kind === 'super')).toBe(true);
  });

  it('getCallableToolNames() without mode returns same count as before', () => {
    const superNames = getRegisteredSuperToolNames();
    const names = getCallableToolNames();
    // super-only (facade excluded by default in getCallableToolNames)
    expect(names).toEqual(superNames);
  });

  it('getRegisteredSuperToolNames() covers all ONTOINDEX_SUPER_TOOLS entries', () => {
    const registered = new Set(getRegisteredSuperToolNames());
    for (const tool of ONTOINDEX_SUPER_TOOLS) {
      expect(registered.has(tool.name)).toBe(true);
    }
  });

  it('getRegisteredFacadeToolNames() covers all ONTOINDEX_FACADE_TOOLS entries', () => {
    const registered = new Set(getRegisteredFacadeToolNames());
    for (const tool of ONTOINDEX_FACADE_TOOLS) {
      expect(registered.has(tool.name)).toBe(true);
    }
  });

  it('marks process-level super tools as repo optional', () => {
    expect(isRepoOptionalSuperToolName('gn_help')).toBe(true);
    expect(isRepoOptionalSuperToolName('gn_tool_contract')).toBe(true);
    expect(isRepoOptionalSuperToolName('gn_quality_mode')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Mode-filtered helpers
// ---------------------------------------------------------------------------

describe('tool-registry — mode-filtered helpers (SERENA-REV1)', () => {
  it('ALL_AGENT_MODES contains general, audit, refactor, and query-projects', () => {
    expect(ALL_AGENT_MODES).toContain('general');
    expect(ALL_AGENT_MODES).toContain('audit');
    expect(ALL_AGENT_MODES).toContain('refactor');
    expect(ALL_AGENT_MODES).toContain('query-projects');
  });

  it('getToolModes returns all agent modes for a known super tool in query-projects', () => {
    const modes = getToolModes('gn_explore');
    expect(modes).toEqual(
      expect.arrayContaining(['general', 'audit', 'refactor', 'query-projects']),
    );
    expect(modes.length).toBe(4);
  });

  it('getToolModes returns all agent modes for a known facade tool in query-projects', () => {
    const modes = getToolModes('impact');
    expect(modes).toEqual(
      expect.arrayContaining(['general', 'audit', 'refactor', 'query-projects']),
    );
  });

  it('getToolModes returns [] for unknown names', () => {
    expect(getToolModes('nonexistent_tool')).toEqual([]);
  });

  it('isToolDiscoverableInMode returns true for public tools in write modes', () => {
    for (const mode of ['general', 'audit', 'refactor'] as const) {
      expect(isToolDiscoverableInMode('gn_explore', mode)).toBe(true);
      expect(isToolDiscoverableInMode('gn_safe_edit_check', mode)).toBe(true);
    }
  });

  it('isToolDiscoverableInMode returns true for discovery tools in query-projects', () => {
    expect(isToolDiscoverableInMode('gn_explore', 'query-projects')).toBe(true);
    expect(isToolDiscoverableInMode('gn_help', 'query-projects')).toBe(true);
    expect(isToolDiscoverableInMode('impact', 'query-projects')).toBe(true);
  });

  it('isToolDiscoverableInMode returns false for write tools in query-projects', () => {
    expect(isToolDiscoverableInMode('gn_safe_edit_check', 'query-projects')).toBe(false);
    expect(isToolDiscoverableInMode('gn_safe_refactor', 'query-projects')).toBe(false);
    expect(isToolDiscoverableInMode('gn_audit_ingest', 'query-projects')).toBe(false);
  });

  it('isToolDiscoverableInMode returns false for unknown names', () => {
    expect(isToolDiscoverableInMode('not_a_tool', 'general')).toBe(false);
  });

  it('getPublicToolRegistry({ mode }) returns non-empty for each mode', () => {
    for (const mode of ALL_AGENT_MODES) {
      const entries = getPublicToolRegistry({ mode });
      expect(entries.length).toBeGreaterThan(0);
    }
  });

  it('getPublicToolRegistry({ mode }) result is a subset of unfiltered result', () => {
    const all = new Set(getPublicToolRegistry().map((e) => e.name));
    for (const mode of ALL_AGENT_MODES) {
      const filtered = getPublicToolRegistry({ mode });
      for (const entry of filtered) {
        expect(all.has(entry.name)).toBe(true);
      }
    }
  });

  it('getCallableToolNames({ mode }) returns same as unfiltered for write modes', () => {
    const unfiltered = getCallableToolNames();
    for (const mode of ['general', 'audit', 'refactor'] as const) {
      const filtered = getCallableToolNames({ mode });
      expect(filtered).toEqual(unfiltered);
    }
  });

  it('getCallableToolNames({ mode: "query-projects" }) returns a non-empty subset', () => {
    const unfiltered = getCallableToolNames();
    const filtered = getCallableToolNames({ mode: 'query-projects' });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(unfiltered.length);
    for (const name of filtered) {
      expect(unfiltered).toContain(name);
    }
  });

  it('getCallableToolNames({ mode: "query-projects" }) contains discovery tools', () => {
    const filtered = getCallableToolNames({ mode: 'query-projects' });
    expect(filtered).toContain('gn_explore');
    expect(filtered).toContain('gn_help');
    expect(filtered).toContain('gn_diagnose');
  });

  it('getCallableToolNames({ mode: "query-projects" }) does not contain write tools', () => {
    const filtered = getCallableToolNames({ mode: 'query-projects' });
    expect(filtered).not.toContain('gn_safe_edit_check');
    expect(filtered).not.toContain('gn_safe_refactor');
    expect(filtered).not.toContain('gn_audit_ingest');
  });
});

// ---------------------------------------------------------------------------
// 3. Backend fallback actions are NOT in public discovery
// ---------------------------------------------------------------------------

describe('tool-registry — backend fallback actions (SERENA-REV1)', () => {
  it('BACKEND_FALLBACK_ACTION_NAMES includes rename_symbol and update_symbol_body', () => {
    expect(BACKEND_FALLBACK_ACTION_NAMES.has('rename_symbol')).toBe(true);
    expect(BACKEND_FALLBACK_ACTION_NAMES.has('update_symbol_body')).toBe(true);
  });

  it('backend fallback actions are not in the public registry', () => {
    const publicNames = new Set(getPublicToolRegistry().map((e) => e.name));
    for (const action of BACKEND_FALLBACK_ACTION_NAMES) {
      expect(publicNames.has(action)).toBe(false);
    }
  });

  it('backend fallback actions are not in getCallableToolNames()', () => {
    const callable = new Set(getCallableToolNames());
    for (const action of BACKEND_FALLBACK_ACTION_NAMES) {
      expect(callable.has(action)).toBe(false);
    }
  });

  it('backend fallback actions return [] from getToolModes (not advertised in any mode)', () => {
    for (const action of BACKEND_FALLBACK_ACTION_NAMES) {
      expect(getToolModes(action)).toEqual([]);
    }
  });

  it('backend fallback actions are not discoverable in any mode', () => {
    for (const action of BACKEND_FALLBACK_ACTION_NAMES) {
      for (const mode of ALL_AGENT_MODES) {
        expect(isToolDiscoverableInMode(action, mode)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. SERENA-D5: query-projects mode — read-only discovery semantics
// ---------------------------------------------------------------------------

describe('tool-registry — query-projects mode (SERENA-D5)', () => {
  it('QUERY_PROJECTS_TOOL_NAMES is a non-empty set', () => {
    expect(QUERY_PROJECTS_TOOL_NAMES.size).toBeGreaterThan(0);
  });

  it('QUERY_PROJECTS_TOOL_NAMES contains core discovery super-tools', () => {
    expect(QUERY_PROJECTS_TOOL_NAMES.has('gn_explore')).toBe(true);
    expect(QUERY_PROJECTS_TOOL_NAMES.has('gn_explain_module')).toBe(true);
    expect(QUERY_PROJECTS_TOOL_NAMES.has('gn_find_related')).toBe(true);
    expect(QUERY_PROJECTS_TOOL_NAMES.has('gn_help')).toBe(true);
    expect(QUERY_PROJECTS_TOOL_NAMES.has('gn_diagnose')).toBe(true);
  });

  it('QUERY_PROJECTS_TOOL_NAMES contains read-only facade tools', () => {
    expect(QUERY_PROJECTS_TOOL_NAMES.has('discover')).toBe(true);
    expect(QUERY_PROJECTS_TOOL_NAMES.has('search')).toBe(true);
    expect(QUERY_PROJECTS_TOOL_NAMES.has('inspect')).toBe(true);
    expect(QUERY_PROJECTS_TOOL_NAMES.has('impact')).toBe(true);
  });

  it('QUERY_PROJECTS_TOOL_NAMES does not contain write/mutation tools', () => {
    expect(QUERY_PROJECTS_TOOL_NAMES.has('gn_safe_edit_check')).toBe(false);
    expect(QUERY_PROJECTS_TOOL_NAMES.has('gn_safe_refactor')).toBe(false);
    expect(QUERY_PROJECTS_TOOL_NAMES.has('gn_pre_commit_audit')).toBe(false);
    expect(QUERY_PROJECTS_TOOL_NAMES.has('gn_audit_ingest')).toBe(false);
  });

  it('all QUERY_PROJECTS_TOOL_NAMES members appear in public registry', () => {
    const publicNames = new Set(getPublicToolRegistry({ includeFacades: true }).map((e) => e.name));
    for (const name of QUERY_PROJECTS_TOOL_NAMES) {
      expect(publicNames.has(name)).toBe(true);
    }
  });

  it('query-projects getPublicToolRegistry is a strict subset of unfiltered', () => {
    const unfiltered = getPublicToolRegistry({ includeFacades: true });
    const qp = getPublicToolRegistry({ includeFacades: true, mode: 'query-projects' });
    const unfilteredNames = new Set(unfiltered.map((e) => e.name));
    expect(qp.length).toBeGreaterThan(0);
    expect(qp.length).toBeLessThan(unfiltered.length);
    for (const e of qp) {
      expect(unfilteredNames.has(e.name)).toBe(true);
    }
  });

  it('write modes are unaffected by query-projects addition', () => {
    const unfiltered = getCallableToolNames();
    for (const mode of ['general', 'audit', 'refactor'] as const) {
      expect(getCallableToolNames({ mode })).toEqual(unfiltered);
    }
  });
});

describe('tool-registry — MCP startup profiles (ADR 0027)', () => {
  it('parses valid startup profiles and falls back to public-full for invalid env values', () => {
    expect(DEFAULT_MCP_STARTUP_PROFILE).toBe('public-full');
    expect(parseMcpStartupProfile('core')).toBe('core');
    expect(parseMcpStartupProfile(' QUERY ')).toBe('query');
    expect(parseMcpStartupProfile('not-a-profile')).toBe('public-full');
    expect(parseMcpStartupProfile(undefined)).toBe('public-full');
    expect(
      getMcpStartupProfileFromEnv({
        [MCP_STARTUP_PROFILE_ENV]: 'definitely-invalid',
      }),
    ).toBe('public-full');
  });

  it('public-full is identical to the current unfiltered public frontier', () => {
    const current = getPublicToolRegistry({ includeFacades: true });
    const publicFull = getPublicToolRegistry({
      includeFacades: true,
      startupProfile: 'public-full',
    });
    const currentDefinitions = getPublicToolDefinitions({ includeFacades: true });
    const publicFullDefinitions = getPublicToolDefinitions({
      includeFacades: true,
      startupProfile: 'public-full',
    });

    expect(publicFull.map((entry) => entry.name)).toEqual(current.map((entry) => entry.name));
    expect(publicFullDefinitions.map((definition) => definition.name)).toEqual(
      currentDefinitions.map((definition) => definition.name),
    );
  });

  it('core is smaller than public-full and contains only facades plus startup basics', () => {
    const core = getPublicToolRegistry({ includeFacades: true, startupProfile: 'core' });
    const publicFull = getPublicToolRegistry({
      includeFacades: true,
      startupProfile: 'public-full',
    });
    const coreNames = core.map((entry) => entry.name);
    const coreSuperNames = core
      .filter((entry) => entry.kind === 'super')
      .map((entry) => entry.name)
      .sort();

    expect(core.length).toBeLessThan(publicFull.length);
    for (const name of getRegisteredFacadeToolNames()) {
      expect(coreNames).toContain(name);
    }
    expect(coreSuperNames).toEqual([
      'gn_diagnose',
      'gn_ensure_fresh',
      'gn_help',
      'gn_quality_mode',
      'gn_tool_contract',
    ]);
  });

  it('query profile reuses query-projects discovery tools without exposing direct write tools', () => {
    const names = getPublicToolRegistry({ includeFacades: true, startupProfile: 'query' }).map(
      (entry) => entry.name,
    );

    for (const name of QUERY_PROJECTS_TOOL_NAMES) {
      expect(names).toContain(name);
    }
    expect(names).toContain('gn_explore');
    expect(names).toContain('gn_docs');
    expect(names).not.toContain('gn_safe_edit_check');
    expect(names).not.toContain('gn_safe_refactor');
    expect(names).not.toContain('gn_audit_ingest');
  });

  it('audit profile includes audit/review/verification/systems tools but not direct refactor tools', () => {
    const names = getPublicToolRegistry({ includeFacades: true, startupProfile: 'audit' }).map(
      (entry) => entry.name,
    );

    expect(names).toContain('gn_audit_ingest');
    expect(names).toContain('gn_audit_replay');
    expect(names).toContain('gn_review_diff');
    expect(names).toContain('gn_verify_diff');
    expect(names).toContain('gn_resource_trace');
    expect(names).not.toContain('gn_safe_refactor');
    expect(names).not.toContain('gn_propose_location');
  });

  it('refactor profile includes safety/refactor/change-review tools but not direct audit tools', () => {
    const names = getPublicToolRegistry({ includeFacades: true, startupProfile: 'refactor' }).map(
      (entry) => entry.name,
    );

    expect(names).toContain('gn_safe_edit_check');
    expect(names).toContain('gn_safe_refactor');
    expect(names).toContain('gn_propose_location');
    expect(names).toContain('gn_verify_diff');
    expect(names).not.toContain('gn_audit_ingest');
    expect(names).not.toContain('gn_resource_trace');
  });

  it('systems profile includes systems-audit tools and keeps non-systems direct tools hidden', () => {
    const names = getPublicToolRegistry({ includeFacades: true, startupProfile: 'systems' }).map(
      (entry) => entry.name,
    );

    expect(names).toContain('gn_resource_trace');
    expect(names).toContain('gn_abi_diff');
    expect(names).toContain('gn_simulate_fault');
    expect(names).not.toContain('gn_audit_ingest');
    expect(names).not.toContain('gn_safe_refactor');
  });

  it('reports hidden-but-callable names and counts for advertise-only profiles', () => {
    const coreReport = getMcpStartupProfileToolReport({
      includeFacades: true,
      startupProfile: 'core',
    });
    const hiddenNames = getHiddenStartupProfileToolNames({
      includeFacades: true,
      startupProfile: 'core',
    });

    expect(coreReport.enforcement).toBe('advertise_only');
    expect(coreReport.fullPublicToolCount).toBeGreaterThan(coreReport.advertisedToolCount);
    expect(coreReport.hiddenButCallableToolCount).toBe(hiddenNames.length);
    expect(coreReport.hiddenToolNames).toEqual(hiddenNames);
    expect(hiddenNames).toContain('gn_safe_refactor');
    expect(hiddenNames).toContain('gn_resource_trace');
    expect(getCallableToolNames({ includeFacades: true, startupProfile: 'core' })).toEqual(
      getCallableToolNames({ includeFacades: true, startupProfile: 'public-full' }),
    );
  });
});

describe('tool-registry — ADR26 classification metadata', () => {
  it('public registry entries expose classification metadata fields', () => {
    const entries = getPublicToolRegistry({ includeFacades: true });
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(Array.isArray(entry.workflowIntents)).toBe(true);
      expect(entry.workflowIntents.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.producesEvidenceClasses)).toBe(true);
      expect(entry.producesEvidenceClasses.length).toBeGreaterThan(0);
      expect(entry.permissionProfile).toBeDefined();
      expect(typeof entry.auditAuthority).toBe('boolean');
      expect(typeof entry.advisoryOnly).toBe('boolean');
    }
  });

  it('advisory/diagnostic evidence defaults to non-authoritative', () => {
    const entries = getPublicToolRegistry({ includeFacades: true });
    const nonAuthoritative = entries.filter((entry) =>
      entry.producesEvidenceClasses.some(
        (evidenceClass) =>
          evidenceClass === 'advisory_memory' || evidenceClass === 'runtime_diagnostic',
      ),
    );
    expect(nonAuthoritative.length).toBeGreaterThan(0);
    expect(nonAuthoritative.every((entry) => entry.auditAuthority === false)).toBe(true);
  });
});
