import type {
  PublicToolRegistryEntry,
  AgentMode,
  ToolPermissionProfile,
  EvidenceSourceContractMetadata,
} from './tool-registry.js';
import type { EvidenceReadClass } from '../../core/runtime/evidence-read-ledger.js';

export interface ToolContractSchema {
  version: 1;
  tools: Array<{
    name: string;
    kind: 'super' | 'facade';
    description: string;
    inputSchema: Record<string, unknown>;
    contractStatus: 'stable' | 'experimental' | 'deprecated';
    structuredOutput: boolean;
    modes?: readonly AgentMode[];
    category?: string;
    intent?: string;
    whenToUse?: string;
    workflowIntents?: readonly string[];
    producesEvidenceClasses?: readonly EvidenceReadClass[];
    permissionProfile?: ToolPermissionProfile;
    auditAuthority?: boolean;
    advisoryOnly?: boolean;
    evidenceSources?: readonly EvidenceSourceContractMetadata[];
    owner?: string;
    replacement?: string;
    fallback?: string;
    properties?: Array<Record<string, unknown>>;
    actions?: Array<Record<string, unknown>>;
  }>;
}

export function serializeToolContract(
  registry: PublicToolRegistryEntry[],
  options: { includeExperimental?: boolean } = {},
): ToolContractSchema {
  const includeExperimental = options.includeExperimental === true;

  const tools = registry
    .filter(
      (entry) =>
        includeExperimental ||
        entry.contractStatus === 'stable' ||
        entry.contractStatus === 'deprecated',
    )
    .map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      description: entry.definition.description,
      inputSchema: entry.definition.inputSchema,
      contractStatus: entry.contractStatus,
      structuredOutput: entry.structuredOutput,
      modes: entry.modes,
      category: entry.category,
      intent: entry.intent,
      whenToUse: entry.whenToUse,
      workflowIntents: entry.workflowIntents,
      producesEvidenceClasses: entry.producesEvidenceClasses,
      permissionProfile: entry.permissionProfile,
      auditAuthority: entry.auditAuthority,
      advisoryOnly: entry.advisoryOnly,
      evidenceSources: entry.evidenceSources.map((source) => ({
        ...source,
        provenanceFields: [...source.provenanceFields],
      })),
      owner: entry.owner,
      replacement: entry.replacement,
      fallback: entry.fallback,
      properties: entry.properties ? JSON.parse(JSON.stringify(entry.properties)) : undefined,
      actions: entry.actions ? JSON.parse(JSON.stringify(entry.actions)) : undefined,
    }));

  return {
    version: 1,
    tools,
  };
}
