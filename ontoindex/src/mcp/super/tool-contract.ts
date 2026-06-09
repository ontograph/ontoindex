import { createRequire } from 'node:module';

import { ONTOINDEX_FACADE_TOOLS } from '../facade/tool-definitions.js';
import {
  ALL_AGENT_MODES,
  type ContractStatus,
  type AgentMode,
  type McpStartupProfile,
  getCallableToolNames,
  getPublicToolRegistry,
  getRegisteredFacadeToolNames,
  getRegisteredSuperToolNames,
  getToolModes,
  type PublicToolRegistryEntry,
  type ToolPermissionProfile,
} from '../shared/tool-registry.js';
import { RELEASE_POLICIES } from '../shared/release-policy.js';
import { getStartupProfileState, gnHelp, type StartupProfileState } from './help.js';
import {
  createEmptyEvidenceReadClassCounts,
  NON_AUTHORITATIVE_EVIDENCE_READ_CLASSES,
  type EvidenceReadClass,
} from '../../core/runtime/evidence-read-ledger.js';

const require = createRequire(import.meta.url);

export interface ToolContractParams {
  includeFacades?: boolean;
  /** When supplied, also computes a mode-filtered frontier comparison and reports it in `modeFrontier`. */
  mode?: AgentMode;
}

export interface ToolContractMissing {
  tool: string;
  advertisedBy: 'gn_help';
  registered: false;
  fallback: string;
  /** Identifies whether the problem is in registry metadata, help advertisement, or MCP definition registration. */
  sourceHint: string;
}

export interface ToolContractExtra {
  tool: string;
  registered: true;
  advertisedByHelp: false;
  /** Identifies whether the problem is in registry metadata, help advertisement, or MCP definition registration. */
  sourceHint: string;
}

/** Mode-filtered frontier comparison — present when `mode` is supplied. */
export interface ModeFrontierSummary {
  mode: AgentMode;
  advertised: string[];
  callable: string[];
  missing: ToolContractMissing[];
  extras: ToolContractExtra[];
  status: 'ok' | 'drift';
}

export interface ToolContractVisibleFrontier {
  mode: AgentMode | 'default';
  activeStartupProfile: McpStartupProfile;
  note: string;
  internalCallable: string[];
  hostVisible: string[];
  clientVisible: string[];
  internalOnly: string[];
  clientOnly: string[];
}

/** Structural integrity check result — always present in the report. */
export interface StructuralCheck {
  check: string;
  status: 'pass' | 'fail';
  details?: string;
}

export interface CompatibilityInventoryEntry {
  tool: string;
  property?: string;
  action?: string;
  status: 'stable' | 'experimental' | 'deprecated';
  owner?: string;
  defaultBehavior?: string;
  replacement?: string;
  plannedRemoval?: string;
}

export interface FacadeActionDrift {
  facade: string;
  missingActions: string[];
  extraActions: string[];
  structuredOutputMismatches: string[];
}

export interface ToolContractReport {
  version: 1;
  status: 'ok' | 'drift';
  /** The requested agent mode, when mode filtering was applied. */
  mode?: AgentMode;
  runtime: {
    packageName: string;
    packageVersion: string;
    superToolCount: number;
    facadeToolCount: number;
    sourceIdentity: {
      moduleUrl: string;
      processId: number;
      nodeVersion: string;
      processStartTime: string;
    };
  };
  advertised: string[];
  callable: string[];
  missing: ToolContractMissing[];
  extras: ToolContractExtra[];
  implementationMissing: Array<{ tool: string; sourceHint: string }>;
  implementationExtra: Array<{ tool: string; sourceHint: string }>;
  facadeActionDrift: FacadeActionDrift[];
  warnings: string[];
  /** Internal vs host-visible callable frontier (useful when startup profiles hide wrappers). */
  visibleFrontier: ToolContractVisibleFrontier;
  /** Mode-filtered frontier comparison. Present only when `mode` is supplied. */
  modeFrontier?: ModeFrontierSummary;
  /** Structural integrity checks (always present). */
  structuralChecks: StructuralCheck[];
  /** Compatibility inventory (Phase 5). */
  compatibilityInventory: CompatibilityInventoryEntry[];
  /** Registry classification inventory (ADR 0026). */
  classificationInventory: ClassificationInventoryEntry[];
  /** Compact classification summary report (ADR 0026). */
  classificationReport: ClassificationReport;
  /** ADR 0027 startup-profile state for the advertised MCP surface. */
  startupProfile: StartupProfileState;
}

export interface ClassificationInventoryEntry {
  tool: string;
  kind: 'super' | 'facade';
  category: PublicToolRegistryEntry['category'];
  contractStatus: ContractStatus;
  workflowIntents: readonly string[];
  producesEvidenceClasses: readonly EvidenceReadClass[];
  permissionProfile?: ToolPermissionProfile;
  auditAuthority: boolean;
  advisoryOnly: boolean;
}

export interface ClassificationReport {
  totalTools: number;
  byStability: Record<ContractStatus, number>;
  byEvidenceClass: Record<EvidenceReadClass, number>;
  byPermissionProfile: Record<ToolPermissionProfile | 'unknown', number>;
  authoritativeTools: number;
  advisoryOnlyTools: number;
  nonAuthoritativeEvidenceClasses: readonly EvidenceReadClass[];
}

export function gnToolContract(params: ToolContractParams = {}): ToolContractReport {
  const includeFacades = params.includeFacades === true;
  const { mode } = params;
  const startupProfile = getStartupProfileState().activeProfile;
  const hostProfiledCallable = getPublicToolRegistry({
    includeFacades,
    mode,
    startupProfile,
  }).map((entry) => entry.name);

  // Registry baseline (Source of Truth)
  const registryEntries = getPublicToolRegistry({ includeFacades, mode });
  const registrySuperEntries = getPublicToolRegistry({ includeFacades: false, mode });

  // advertised: from gn_help
  const advertised = sorted(gnHelp({ mode }).superFunctions.map((entry) => entry.name));

  // superCallable: registered in ONTOINDEX_SUPER_TOOLS
  const superCallable = getRegisteredSuperToolNames();

  // callable: registered in ONTOINDEX_SUPER_TOOLS + ONTOINDEX_FACADE_TOOLS
  const callable = getCallableToolNames({ includeFacades, mode });

  const callableSet = new Set(callable);
  const advertisedSet = new Set(advertised);
  const registrySet = new Set(registryEntries.map((e) => e.name));
  const registrySuperSet = new Set(registrySuperEntries.map((e) => e.name));

  // Drift check 1: gn_help advertisement vs Registry (Super-functions only)
  const missing = advertised
    .filter((tool) => !registrySuperSet.has(tool))
    .map((tool) => ({
      tool,
      advertisedBy: 'gn_help' as const,
      registered: false as const,
      fallback: fallbackForTool(tool),
      sourceHint: `Tool "${tool}" advertised by gn_help is missing from the registry.`,
    }));

  const extras = registrySuperEntries
    .map((e) => e.name)
    .filter((tool) => !advertisedSet.has(tool))
    .map((tool) => ({
      tool,
      registered: true as const,
      advertisedByHelp: false as const,
      sourceHint: `Tool "${tool}" is in the registry but not advertised by gn_help.`,
    }));

  const drifted = missing.length > 0 || extras.length > 0;

  // Drift check 2: Registry vs Callable (Implementation Parity)
  const implementationMissing = registryEntries
    .filter((e) => !callableSet.has(e.name))
    .map((e) => ({
      tool: e.name,
      sourceHint: `Tool "${e.name}" is in the registry but not registered as callable in MCP.`,
    }));

  const implementationExtra = callable
    .filter((name) => !registrySet.has(name))
    .map((name) => ({
      tool: name,
      sourceHint: `Tool "${name}" is registered in MCP but missing from the registry.`,
    }));

  const implementationDrifted = implementationMissing.length > 0 || implementationExtra.length > 0;

  // Drift check 3: Facade Action Drift (Phase 2.6)
  const facadeActionDrift: FacadeActionDrift[] = [];
  if (includeFacades) {
    for (const entry of registryEntries.filter((e) => e.kind === 'facade')) {
      const toolDef = ONTOINDEX_FACADE_TOOLS.find((t) => t.name === entry.name);
      if (!toolDef) continue;

      const schemaActions = (toolDef.inputSchema.properties.action as any)?.enum ?? [];
      const registryActions = entry.actions ?? [];
      const registryActionNames = registryActions.map((a) => a.action);

      const missingActions = registryActionNames.filter((a) => !schemaActions.includes(a));
      const extraActions = schemaActions.filter((a) => !registryActionNames.includes(a));
      const structuredOutputMismatches: string[] = [];

      // Check for structured output consistency and dispatch category drift
      const toolHasSOProp =
        'structured_output' in (toolDef.inputSchema.properties ?? {}) ||
        'structuredOutput' in (toolDef.inputSchema.properties ?? {}) ||
        'legacyResponse' in (toolDef.inputSchema.properties ?? {});

      // Enrichment properties (sidecar facts) usually imply structured evidence output
      const toolHasEnrichment =
        'consume_enrichment_facts' in (toolDef.inputSchema.properties ?? {});

      for (const actionInfo of registryActions) {
        if (!schemaActions.includes(actionInfo.action)) continue;

        // Verify structuredOutput metadata aligns with actual tool support.
        if (actionInfo.structuredOutput && !toolHasSOProp && !toolHasEnrichment) {
          // docs, discover, and manage are inherently structured in their final response
          // or use complex toggles (like docs format enum) that satisfy the requirement.
          const isInherentlyStructured = ['discover', 'manage', 'docs'].includes(entry.name);
          if (!isInherentlyStructured) {
            structuredOutputMismatches.push(
              `Action "${actionInfo.action}" claims structuredOutput support but facade "${entry.name}" has no structured output property or enrichment metadata.`,
            );
          }
        }
      }

      if (
        missingActions.length > 0 ||
        extraActions.length > 0 ||
        structuredOutputMismatches.length > 0
      ) {
        facadeActionDrift.push({
          facade: entry.name,
          missingActions,
          extraActions,
          structuredOutputMismatches,
        });
      }
    }
  }

  const actionDrifted = facadeActionDrift.length > 0;

  // Compatibility inventory
  const compatibilityInventory: CompatibilityInventoryEntry[] = [];
  for (const entry of registryEntries) {
    if (entry.replacement || entry.fallback || entry.contractStatus === 'experimental') {
      compatibilityInventory.push({
        tool: entry.name,
        status: entry.contractStatus === 'stable' ? 'deprecated' : 'experimental',
        owner: entry.owner,
        defaultBehavior: entry.defaultBehavior,
        replacement: entry.replacement ?? entry.fallback,
      });
    }
    if (entry.properties) {
      for (const prop of entry.properties) {
        if (prop.contractStatus === 'experimental' || prop.replacement) {
          compatibilityInventory.push({
            tool: entry.name,
            property: prop.property,
            status: prop.contractStatus,
            owner: prop.owner,
            defaultBehavior: prop.defaultBehavior,
            replacement: prop.replacement,
          });
        }
      }
    }
    if (entry.actions) {
      for (const actionInfo of entry.actions) {
        if (actionInfo.contractStatus === 'experimental' || actionInfo.replacement) {
          compatibilityInventory.push({
            tool: entry.name,
            action: actionInfo.action,
            status: actionInfo.contractStatus,
            owner: actionInfo.owner,
            defaultBehavior: actionInfo.defaultBehavior,
            replacement: actionInfo.replacement,
          });
        }
      }
    }
  }

  const classificationInventory = buildClassificationInventory(registryEntries);
  const classificationReport = buildClassificationReport(classificationInventory);

  // Structural integrity checks (always run regardless of mode)
  const structuralChecks = runStructuralChecks(includeFacades, registryEntries);
  const visibleFrontier = computeVisibleFrontier({
    mode: mode ?? 'default',
    startupProfile: startupProfile,
    registryEntries,
    callable: hostProfiledCallable,
    registrySet,
  });

  const warnings: string[] = [];
  if (drifted) {
    warnings.push(
      'gn_help and registry super-function contract differ; check help.ts or tool-registry.ts.',
    );
  }
  if (implementationDrifted) {
    warnings.push(
      'Registry and MCP registered tools (super + facade) differ; check tool-definitions.ts or tool-registry.ts.',
    );
  }
  if (visibleFrontier.internalOnly.length > 0) {
    warnings.push(
      'Host-visible wrappers are a subset of internal callable tools due to startup-profile or mode filtering; review visibleFrontier.clientVisible and visibleFrontier.internalOnly.',
    );
  }
  if (actionDrifted) {
    warnings.push(
      'Facade actions in registry and tool definitions differ; check tool-definitions.ts or tool-registry.ts.',
    );
  }
  for (const check of structuralChecks) {
    if (check.status === 'fail') {
      warnings.push(
        `Structural check failed [${check.check}]: ${check.details ?? 'see structuralChecks for details'}`,
      );
    }
  }

  // Mode-frontier comparison (only when mode is supplied)
  let modeFrontier: ModeFrontierSummary | undefined;
  if (mode !== undefined) {
    modeFrontier = computeModeFrontier(mode, superCallable);
    if (modeFrontier.status === 'drift') {
      warnings.push(
        `Mode [${mode}] frontier has drift between gn_help({mode}) advertised tools and mode-discoverable MCP tools.`,
      );
    }
  }

  return {
    version: 1,
    status: drifted || implementationDrifted || actionDrifted ? 'drift' : 'ok',
    ...(mode !== undefined ? { mode } : {}),
    runtime: runtimeMetadata(superCallable.length, getRegisteredFacadeToolNames().length),
    advertised,
    callable,
    missing,
    extras,
    implementationMissing,
    implementationExtra,
    facadeActionDrift,
    warnings,
    visibleFrontier,
    ...(modeFrontier !== undefined ? { modeFrontier } : {}),
    structuralChecks,
    compatibilityInventory,
    classificationInventory,
    classificationReport,
    startupProfile: getStartupProfileState(),
  };
}

function runtimeMetadata(
  superToolCount: number,
  facadeToolCount: number,
): ToolContractReport['runtime'] {
  const pkg = readPackageJson();
  return {
    packageName: pkg.name,
    packageVersion: pkg.version,
    superToolCount,
    facadeToolCount,
    sourceIdentity: {
      moduleUrl: import.meta.url,
      processId: process.pid,
      nodeVersion: process.version,
      processStartTime: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
  };
}

function readPackageJson(): { name: string; version: string } {
  try {
    const pkg = require('../../../package.json') as { name?: unknown; version?: unknown };
    return {
      name: typeof pkg.name === 'string' ? pkg.name : 'ontoindex',
      version: typeof pkg.version === 'string' ? pkg.version : 'unknown',
    };
  } catch {
    return { name: 'ontoindex', version: 'unknown' };
  }
}

function computeModeFrontier(mode: AgentMode, superCallable: string[]): ModeFrontierSummary {
  const advertised = sorted(gnHelp({ mode }).superFunctions.map((entry) => entry.name));
  // gn_help advertises the super-function frontier only. Keep the mode
  // comparison on that same frontier even when the top-level report includes
  // facades, otherwise every facade becomes a false-positive extra.
  const callable = getCallableToolNames({ includeFacades: false, mode });
  const callableSet = new Set(callable);
  const advertisedSet = new Set(advertised);

  const missing = advertised
    .filter((tool) => !callableSet.has(tool))
    .map((tool) => ({
      tool,
      advertisedBy: 'gn_help' as const,
      registered: false as const,
      fallback: fallbackForTool(tool),
      sourceHint: `Tool "${tool}" is advertised by gn_help({mode: "${mode}"}) but not discoverable in mode "${mode}" via MCP. Check registry metadata in tool-registry.ts.`,
    }));

  const extras = callable
    .filter((tool) => !advertisedSet.has(tool))
    .map((tool) => ({
      tool,
      registered: true as const,
      advertisedByHelp: false as const,
      sourceHint: `Tool "${tool}" is callable in mode "${mode}" but not advertised by gn_help({mode: "${mode}"}). Check help.ts or registry metadata.`,
    }));

  return {
    mode,
    advertised,
    callable,
    missing,
    extras,
    status: missing.length === 0 && extras.length === 0 ? 'ok' : 'drift',
  };
}

function computeVisibleFrontier(input: {
  mode: AgentMode | 'default';
  startupProfile: McpStartupProfile;
  registryEntries: readonly PublicToolRegistryEntry[];
  callable: readonly string[];
  registrySet: Set<string>;
}): ToolContractVisibleFrontier {
  const internalCallable = sorted(input.registryEntries.map((entry) => entry.name));
  const hostVisible = sorted(input.callable);
  const hostSet = new Set(hostVisible);

  const clientVisible = hostVisible;
  const internalOnly = internalCallable.filter((tool) => !hostSet.has(tool));
  const clientOnly = hostVisible.filter((tool) => !input.registrySet.has(tool));

  const modeDescription = input.mode === 'default' ? 'all modes' : `mode "${input.mode}"`;
  const note = [
    `Callable tools in the OntoIndex registry (${modeDescription}) are compared with host-discoverable wrappers for this process.`,
    `Startup-profile filter currently set to "${input.startupProfile}" can hide internal tools from hosts.`,
    'If a host reports missing wrappers for visible tools, request the same startup-profile and frontier in that host context.',
  ].join(' ');

  return {
    mode: input.mode,
    activeStartupProfile: input.startupProfile,
    note,
    internalCallable,
    hostVisible,
    clientVisible,
    internalOnly,
    clientOnly,
  };
}

function runStructuralChecks(
  includeFacades: boolean,
  registryEntries: PublicToolRegistryEntry[],
): StructuralCheck[] {
  const checks: StructuralCheck[] = [
    checkUnknownModeMetadata(),
    checkDuplicateAliases(),
    checkMinEntrypointsPerMode(includeFacades),
  ];

  // Evaluate release policies
  for (const policy of RELEASE_POLICIES) {
    const result = policy.evaluate(registryEntries);
    checks.push({
      check: `policy:${policy.id}`,
      status: result.status,
      details: result.violations.length > 0 ? result.violations.join('; ') : undefined,
    });
  }

  return checks;
}

function checkUnknownModeMetadata(): StructuralCheck {
  const allToolNames = [...getRegisteredSuperToolNames(), ...getRegisteredFacadeToolNames()];
  const unknownModeTools: string[] = [];
  for (const name of allToolNames) {
    for (const m of getToolModes(name)) {
      if (!(ALL_AGENT_MODES as readonly string[]).includes(m)) {
        unknownModeTools.push(`${name} has unknown mode "${m}"`);
      }
    }
  }
  if (unknownModeTools.length > 0) {
    return {
      check: 'unknown-mode-metadata',
      status: 'fail',
      details: `Tools with unknown modes in registry metadata: ${unknownModeTools.join('; ')}. Fix in tool-registry.ts.`,
    };
  }
  return { check: 'unknown-mode-metadata', status: 'pass' };
}

function checkDuplicateAliases(): StructuralCheck {
  const superNames = new Set(getRegisteredSuperToolNames());
  const duplicates = getRegisteredFacadeToolNames().filter((name) => superNames.has(name));
  if (duplicates.length > 0) {
    return {
      check: 'duplicate-aliases',
      status: 'fail',
      details: `Tool names appear in both super and facade registries: ${duplicates.join(', ')}. Fix in tool-definitions.ts.`,
    };
  }
  return { check: 'duplicate-aliases', status: 'pass' };
}

function checkMinEntrypointsPerMode(includeFacades: boolean): StructuralCheck {
  const modesWithNoTools: AgentMode[] = [];
  for (const m of ALL_AGENT_MODES) {
    if (getCallableToolNames({ includeFacades, mode: m }).length === 0) {
      modesWithNoTools.push(m);
    }
  }
  if (modesWithNoTools.length > 0) {
    return {
      check: 'min-entrypoints-per-mode',
      status: 'fail',
      details: `No callable tools found for mode(s): ${modesWithNoTools.join(', ')}. Each mode must have at least one discoverable tool in tool-registry.ts.`,
    };
  }
  return { check: 'min-entrypoints-per-mode', status: 'pass' };
}

function fallbackForTool(tool: string): string {
  if (tool.startsWith('gn_audit_'))
    return 'Use audit(action:"patterns") plus manual source verification.';
  if (tool.startsWith('gn_') && tool.includes('resource'))
    return 'Use inspect({action:"evidence"}) plus manual source verification.';
  if (tool.startsWith('gn_'))
    return 'Use gn_explore, gn_find_related, inspect, and impact as fallback.';
  return 'No fallback registered.';
}

function sorted(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function buildClassificationInventory(
  entries: readonly PublicToolRegistryEntry[],
): ClassificationInventoryEntry[] {
  return [...entries]
    .map((entry) => ({
      tool: entry.name,
      kind: entry.kind,
      category: entry.category,
      contractStatus: entry.contractStatus,
      workflowIntents: sorted(entry.workflowIntents),
      producesEvidenceClasses: sorted(entry.producesEvidenceClasses) as EvidenceReadClass[],
      permissionProfile: entry.permissionProfile,
      auditAuthority: entry.auditAuthority,
      advisoryOnly: entry.advisoryOnly,
    }))
    .sort((a, b) => a.tool.localeCompare(b.tool));
}

function buildClassificationReport(
  inventory: readonly ClassificationInventoryEntry[],
): ClassificationReport {
  const byStability: Record<ContractStatus, number> = {
    stable: 0,
    experimental: 0,
    deprecated: 0,
  };
  const byEvidenceClass = createEmptyEvidenceReadClassCounts();
  const byPermissionProfile: Record<ToolPermissionProfile | 'unknown', number> = {
    read_only: 0,
    advisory: 0,
    write_dry_run: 0,
    write_apply: 0,
    release: 0,
    runtime_admin: 0,
    unknown: 0,
  };

  let authoritativeTools = 0;
  let advisoryOnlyTools = 0;
  for (const entry of inventory) {
    byStability[entry.contractStatus] = (byStability[entry.contractStatus] ?? 0) + 1;
    const permissionKey = entry.permissionProfile ?? 'unknown';
    byPermissionProfile[permissionKey] = (byPermissionProfile[permissionKey] ?? 0) + 1;
    if (entry.auditAuthority) authoritativeTools++;
    if (entry.advisoryOnly) advisoryOnlyTools++;
    for (const evidenceClass of entry.producesEvidenceClasses) {
      byEvidenceClass[evidenceClass] = (byEvidenceClass[evidenceClass] ?? 0) + 1;
    }
  }

  return {
    totalTools: inventory.length,
    byStability,
    byEvidenceClass,
    byPermissionProfile,
    authoritativeTools,
    advisoryOnlyTools,
    nonAuthoritativeEvidenceClasses: NON_AUTHORITATIVE_EVIDENCE_READ_CLASSES,
  };
}
