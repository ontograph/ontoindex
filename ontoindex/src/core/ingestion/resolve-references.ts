/** Materialize supported reference sites after finalization and before emission. */
import { buildClassRegistry, buildFieldRegistry, buildMethodRegistry } from 'ontoindex-shared';
import type {
  DefId,
  Reference,
  ReferenceIndex,
  RegistryProviders,
  ScopeId,
} from 'ontoindex-shared';
import { buildScopeRegistryContext } from './finalize-orchestrator.js';
import type { ScopeResolutionIndexes } from './model/scope-resolution-indexes.js';

interface ReferenceResolutionResult {
  referenceIndex: ReferenceIndex;
  stats: {
    totalSites: number;
    resolvedSites: number;
    unresolvedSites: number;
    ambiguousSites: number;
    unsupportedSites: number;
  };
}

/**
 * Resolve free/member calls, identifier/property reads, identifier writes, and Class-only constructors as singleton matches.
 * Constructor support is bounded to the TS/JS slice; Struct and Record remain deferred.
 */
export function resolveReferences(
  indexes: ScopeResolutionIndexes,
  providers: RegistryProviders = {},
): ReferenceResolutionResult {
  return resolveReferenceSites(indexes, providers, true);
}

/** Preserve the free-call-only entry point and its stats partition. */
export function resolveFreeCallReferences(
  indexes: ScopeResolutionIndexes,
  providers: RegistryProviders = {},
): ReferenceResolutionResult {
  return resolveReferenceSites(indexes, providers, false);
}

function resolveReferenceSites(
  indexes: ScopeResolutionIndexes,
  providers: RegistryProviders,
  includeExtendedSites: boolean,
): ReferenceResolutionResult {
  const context = buildScopeRegistryContext(indexes, providers);
  const methodRegistry = buildMethodRegistry(context);
  const fieldRegistry = includeExtendedSites ? buildFieldRegistry(context) : undefined;
  const classRegistry = includeExtendedSites ? buildClassRegistry(context) : undefined;
  const bySourceScope = new Map<ScopeId, Reference[]>();
  const byTargetDef = new Map<DefId, Reference[]>();
  const stats = {
    totalSites: indexes.referenceSites.length,
    resolvedSites: 0,
    unresolvedSites: 0,
    ambiguousSites: 0,
    unsupportedSites: 0,
  };

  for (const site of indexes.referenceSites) {
    if (site.selection !== undefined) {
      stats.unsupportedSites++;
      continue;
    }
    const isFreeCall = site.kind === 'call' && site.callForm === 'free';
    const isRead = includeExtendedSites && site.kind === 'read' && site.callForm === undefined;
    const isWrite =
      includeExtendedSites &&
      site.kind === 'write' &&
      site.callForm === undefined &&
      site.explicitReceiver === undefined;
    const isConstructorCall =
      includeExtendedSites && site.kind === 'call' && site.callForm === 'constructor';
    const isMemberCall =
      includeExtendedSites &&
      site.kind === 'call' &&
      site.callForm === 'member' &&
      site.explicitReceiver !== undefined;
    if (
      (!isFreeCall && !isRead && !isWrite && !isConstructorCall && !isMemberCall) ||
      (site.explicitReceiver !== undefined && !isMemberCall && !isRead)
    ) {
      stats.unsupportedSites++;
      continue;
    }
    if (!context.scopes.has(site.inScope)) {
      stats.unresolvedSites++;
      continue;
    }

    const candidates =
      isRead || isWrite
        ? fieldRegistry!.lookup(site.name, site.inScope, {
            lexicalNamespace: 'value',
            ...(site.explicitReceiver !== undefined
              ? { explicitReceiver: site.explicitReceiver }
              : {}),
          })
        : isConstructorCall
          ? classRegistry!.lookup(site.name, site.inScope, { lexicalNamespace: 'value' })
          : methodRegistry.lookup(site.name, site.inScope, {
              lexicalNamespace: 'value',
              ...(site.arity !== undefined ? { callsite: { arity: site.arity } } : {}),
              ...(isMemberCall ? { explicitReceiver: site.explicitReceiver } : {}),
            });
    if (candidates.length === 0) {
      stats.unresolvedSites++;
      continue;
    }
    if (candidates.length > 1) {
      stats.ambiguousSites++;
      continue;
    }

    const candidate = candidates[0]!;
    if (
      (isFreeCall || isMemberCall) &&
      candidate.evidence.some(
        (evidence) => evidence.kind === 'arity-match' && evidence.note === 'incompatible',
      )
    ) {
      stats.unresolvedSites++;
      continue;
    }
    if (isConstructorCall && candidate.def.type !== 'Class') {
      stats.unresolvedSites++;
      continue;
    }
    const reference: Reference = {
      fromScope: site.inScope,
      toDef: candidate.def.nodeId,
      atRange: { ...site.atRange },
      kind: site.kind,
      confidence: candidate.confidence,
      evidence: candidate.evidence.map((evidence) => ({ ...evidence })),
    };
    const sourceBucket = bySourceScope.get(reference.fromScope);
    if (sourceBucket) sourceBucket.push(reference);
    else bySourceScope.set(reference.fromScope, [reference]);
    const targetBucket = byTargetDef.get(reference.toDef);
    if (targetBucket) targetBucket.push(reference);
    else byTargetDef.set(reference.toDef, [reference]);
    stats.resolvedSites++;
  }

  for (const bucket of bySourceScope.values()) Object.freeze(bucket);
  for (const bucket of byTargetDef.values()) Object.freeze(bucket);

  return { referenceIndex: { bySourceScope, byTargetDef }, stats };
}
