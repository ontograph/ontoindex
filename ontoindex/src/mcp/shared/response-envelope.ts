import type { TargetContext } from './target-context.js';

export interface GlobalTargetContext {
  scope: 'global';
  reason: string;
}

export type EnvelopeTargetContext = TargetContext | GlobalTargetContext;

export interface CapabilityResponseFreshness {
  status: 'fresh' | 'stale' | 'degraded' | 'unknown' | 'not-applicable';
  actionable: boolean;
  reason: string;
  targetHead?: string;
  currentHead?: string;
  indexedHead?: string;
  snapshotMode?: string;
}

export interface CapabilityResponseEnvelope<
  TResult = Record<string, unknown>,
  TEvidence = unknown,
> extends Record<string, unknown> {
  envelopeVersion: '1';
  tool: string;
  version: number | string;
  status: string;
  targetContext: EnvelopeTargetContext;
  capabilitiesUsed: string[];
  capabilitiesMissing: string[];
  freshness: CapabilityResponseFreshness;
  results: TResult;
  evidence: TEvidence[];
  warnings: string[];
  limits: Record<string, unknown>;
  nextTools: string[];
}

export interface CapabilityDiagnostics {
  capabilitiesUsed: string[];
  capabilitiesMissing: string[];
  warnings: string[];
}

export interface CapabilityDiagnosticsOptions {
  capabilitiesUsed?: readonly string[];
  capabilitiesMissing?: readonly string[];
  targetContext?: EnvelopeTargetContext;
  semanticFallbackUsed?: boolean;
  typeAwareClaimsDowngraded?: boolean;
  lspCapability?: string;
  diagnosticsRequested?: boolean;
  sidecarAffectsQuality?: boolean;
  sidecarCapability?: string;
}

export interface EnvelopeFromLegacyOptions<
  TLegacy extends object = Record<string, unknown>,
  TEvidence = unknown,
> extends CapabilityDiagnosticsOptions {
  legacy: TLegacy;
  tool: string;
  status: string;
  targetContext: EnvelopeTargetContext;
  freshness?: CapabilityResponseFreshness;
  evidence?: readonly TEvidence[];
  limits?: Record<string, unknown>;
  nextTools?: readonly string[];
  omitResultKeys?: readonly string[];
}

const DEFAULT_OMIT_RESULT_KEYS = [
  'envelopeVersion',
  'tool',
  'version',
  'status',
  'targetContext',
  'capabilitiesUsed',
  'capabilitiesMissing',
  'freshness',
  'warnings',
  'limits',
  'nextTools',
];

export function createGlobalTargetContext(
  reason = 'tool does not require repository resolution',
): GlobalTargetContext {
  return { scope: 'global', reason };
}

export function deriveEnvelopeFreshness(
  targetContext: EnvelopeTargetContext,
  overrides: Partial<CapabilityResponseFreshness> = {},
): CapabilityResponseFreshness {
  const base =
    'scope' in targetContext
      ? {
          status: 'not-applicable' as const,
          actionable: true,
          reason: targetContext.reason,
        }
      : targetContext.status !== 'ok'
        ? {
            status: 'unknown' as const,
            actionable: false,
            reason: targetContext.action ?? `target-context:${targetContext.status}`,
            targetHead: targetContext.targetHead,
            currentHead: targetContext.currentHead,
            indexedHead: targetContext.indexedHead,
            snapshotMode: targetContext.snapshotMode,
          }
        : targetContext.indexedHead &&
            targetContext.targetHead &&
            targetContext.indexedHead !== targetContext.targetHead
          ? {
              status: 'stale' as const,
              actionable: false,
              reason: 'indexedHead != targetHead',
              targetHead: targetContext.targetHead,
              currentHead: targetContext.currentHead,
              indexedHead: targetContext.indexedHead,
              snapshotMode: targetContext.snapshotMode,
            }
          : targetContext.dirtyWorktree === true
            ? {
                status: 'degraded' as const,
                actionable: false,
                reason: 'dirty-worktree-overlay',
                targetHead: targetContext.targetHead,
                currentHead: targetContext.currentHead,
                indexedHead: targetContext.indexedHead,
                snapshotMode: targetContext.snapshotMode,
              }
            : {
                status: 'fresh' as const,
                actionable: true,
                reason: 'target context aligned',
                targetHead: targetContext.targetHead,
                currentHead: targetContext.currentHead,
                indexedHead: targetContext.indexedHead,
                snapshotMode: targetContext.snapshotMode,
              };

  return { ...base, ...overrides };
}

export function collectCapabilityDiagnostics(
  options: CapabilityDiagnosticsOptions,
): CapabilityDiagnostics {
  const capabilitiesUsed = unique(options.capabilitiesUsed ?? []);
  const capabilitiesMissing = new Set(options.capabilitiesMissing ?? []);
  const warnings: string[] = [];

  if (options.semanticFallbackUsed && !embeddingsAvailable(options.targetContext)) {
    capabilitiesMissing.add('embeddings');
    warnings.push(
      'Embeddings unavailable; semantic retrieval fell back to lexical/graph ranking. Run: ontoindex analyze --embeddings',
    );
  }

  if (options.typeAwareClaimsDowngraded && !lspAvailable(options.targetContext)) {
    capabilitiesMissing.add(options.lspCapability ?? 'lsp');
    warnings.push(
      `LSP unavailable; type-aware claims were downgraded to non-LSP evidence${reasonSuffix(options.targetContext)}.`,
    );
  }

  const sidecarStatus = readSidecarStatus(options.targetContext);
  if (
    (options.sidecarAffectsQuality || options.diagnosticsRequested) &&
    sidecarStatus &&
    sidecarStatus !== 'available' &&
    sidecarStatus !== 'unknown'
  ) {
    capabilitiesMissing.add(options.sidecarCapability ?? 'sidecar');
    if (options.sidecarAffectsQuality) {
      warnings.push(`Sidecar ${sidecarStatus}; result quality is degraded.`);
    }
  }

  return {
    capabilitiesUsed,
    capabilitiesMissing: unique([...capabilitiesMissing]),
    warnings,
  };
}

export function createCapabilityResponseEnvelope<TResult, TEvidence = unknown>(input: {
  tool: string;
  version: number | string;
  status: string;
  targetContext: EnvelopeTargetContext;
  capabilitiesUsed?: readonly string[];
  capabilitiesMissing?: readonly string[];
  freshness: CapabilityResponseFreshness;
  results: TResult;
  evidence?: readonly TEvidence[];
  warnings?: readonly string[];
  limits?: Record<string, unknown>;
  nextTools?: readonly string[];
}): CapabilityResponseEnvelope<TResult, TEvidence> {
  return {
    envelopeVersion: '1',
    tool: input.tool,
    version: input.version,
    status: input.status,
    targetContext: input.targetContext,
    capabilitiesUsed: unique(input.capabilitiesUsed ?? []),
    capabilitiesMissing: unique(input.capabilitiesMissing ?? []),
    freshness: input.freshness,
    results: input.results,
    evidence: [...(input.evidence ?? [])],
    warnings: unique(input.warnings ?? []),
    limits: input.limits ?? defaultLimits(),
    nextTools: unique(input.nextTools ?? []),
  };
}

export function createEnvelopeFromLegacy<TLegacy extends object, TEvidence = unknown>(
  input: EnvelopeFromLegacyOptions<TLegacy, TEvidence>,
): CapabilityResponseEnvelope<Record<string, unknown>, TEvidence> {
  const diagnostics = collectCapabilityDiagnostics(input);
  return createCapabilityResponseEnvelope({
    tool: input.tool,
    version: readLegacyVersion(input.legacy),
    status: input.status,
    targetContext: input.targetContext,
    capabilitiesUsed: diagnostics.capabilitiesUsed,
    capabilitiesMissing: diagnostics.capabilitiesMissing,
    freshness: input.freshness ?? deriveEnvelopeFreshness(input.targetContext),
    results: legacyReportToEnvelopeResults(input.legacy, input.omitResultKeys),
    evidence: input.evidence,
    warnings: [...readLegacyWarnings(input.legacy), ...diagnostics.warnings],
    limits: input.limits ?? readLegacyLimits(input.legacy),
    nextTools: input.nextTools ?? readLegacyNextTools(input.legacy),
  });
}

export function legacyReportToEnvelopeResults(
  legacy: object,
  omitResultKeys: readonly string[] = DEFAULT_OMIT_RESULT_KEYS,
): Record<string, unknown> {
  const record = toRecord(legacy);
  const omit = new Set(omitResultKeys);
  return Object.fromEntries(Object.entries(record).filter(([key]) => !omit.has(key)));
}

function readLegacyVersion(legacy: object): number | string {
  const version = toRecord(legacy)['version'];
  return typeof version === 'number' || typeof version === 'string' ? version : 1;
}

function readLegacyWarnings(legacy: object): string[] {
  const warnings = toRecord(legacy)['warnings'];
  return Array.isArray(warnings)
    ? warnings.filter((value): value is string => typeof value === 'string')
    : [];
}

function readLegacyLimits(legacy: object): Record<string, unknown> {
  const limits = toRecord(legacy)['limits'];
  return isRecord(limits) ? limits : defaultLimits();
}

function readLegacyNextTools(legacy: object): string[] {
  const nextTools = toRecord(legacy)['nextTools'];
  return Array.isArray(nextTools)
    ? nextTools.filter((value): value is string => typeof value === 'string')
    : [];
}

function embeddingsAvailable(targetContext: EnvelopeTargetContext | undefined): boolean {
  return (
    targetContext !== undefined &&
    !('scope' in targetContext) &&
    targetContext.embeddings.status === 'available'
  );
}

function lspAvailable(targetContext: EnvelopeTargetContext | undefined): boolean {
  return (
    targetContext !== undefined &&
    !('scope' in targetContext) &&
    targetContext.lsp.status === 'available'
  );
}

function readSidecarStatus(
  targetContext: EnvelopeTargetContext | undefined,
): TargetContext['sidecar']['status'] | undefined {
  return targetContext !== undefined && !('scope' in targetContext)
    ? targetContext.sidecar.status
    : undefined;
}

function reasonSuffix(targetContext: EnvelopeTargetContext | undefined): string {
  return targetContext !== undefined &&
    !('scope' in targetContext) &&
    typeof targetContext.lsp.reason === 'string'
    ? ` (${targetContext.lsp.reason})`
    : '';
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function defaultLimits(): Record<string, unknown> {
  return {
    truncated: false,
    cursor: null,
    persistedPath: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}
