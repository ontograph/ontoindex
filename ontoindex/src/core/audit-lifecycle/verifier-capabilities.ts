import type { AuditClaimDsl, EvidenceMode, ReasonCode } from './audit-types.js';

export interface VerifierCapability {
  verifierId: string;
  verifierVersion: string;
  claimKind: string;
  supportedLanguages: string[];
  supportedEvidenceModes: EvidenceMode[];
  maxInterproceduralDepth: number;
  pathSensitive: boolean;
  resourceAware: boolean;
  runtimeRequired: boolean;
  unsupportedBehavior: 'NEEDS-VERIFY' | 'HOLD';
}

export interface UnsupportedClaimClassification {
  supported: boolean;
  behavior: 'NEEDS-VERIFY' | 'HOLD';
  reasonCodes: ReasonCode[];
  capability: VerifierCapability | null;
}

export const DEFAULT_VERIFIER_CAPABILITIES: VerifierCapability[] = [
  {
    verifierId: 'audit-lifecycle-static-patterns',
    verifierVersion: '0.1.0',
    claimKind: 'forbidden-call-pattern',
    supportedLanguages: ['c', 'cpp', 'typescript', 'javascript'],
    supportedEvidenceModes: ['ast', 'call-graph'],
    maxInterproceduralDepth: 1,
    pathSensitive: false,
    resourceAware: false,
    runtimeRequired: false,
    unsupportedBehavior: 'NEEDS-VERIFY',
  },
  {
    verifierId: 'audit-lifecycle-resource-static',
    verifierVersion: '0.1.0',
    claimKind: 'missing-cleanup',
    supportedLanguages: ['c', 'cpp'],
    supportedEvidenceModes: ['resource-lifecycle', 'call-graph'],
    maxInterproceduralDepth: 3,
    pathSensitive: true,
    resourceAware: true,
    runtimeRequired: false,
    unsupportedBehavior: 'NEEDS-VERIFY',
  },
  {
    verifierId: 'audit-lifecycle-resource-static',
    verifierVersion: '0.1.0',
    claimKind: 'resource-leak',
    supportedLanguages: ['c', 'cpp'],
    supportedEvidenceModes: ['resource-lifecycle', 'call-graph'],
    maxInterproceduralDepth: 3,
    pathSensitive: true,
    resourceAware: true,
    runtimeRequired: false,
    unsupportedBehavior: 'NEEDS-VERIFY',
  },
  {
    verifierId: 'audit-lifecycle-test-presence',
    verifierVersion: '0.1.0',
    claimKind: 'missing-test',
    supportedLanguages: ['typescript', 'javascript'],
    supportedEvidenceModes: ['test', 'manual-review'],
    maxInterproceduralDepth: 0,
    pathSensitive: false,
    resourceAware: false,
    runtimeRequired: false,
    unsupportedBehavior: 'NEEDS-VERIFY',
  },
];

export function classifyUnsupportedClaim(
  claim: AuditClaimDsl | null,
  capabilities: readonly VerifierCapability[] = DEFAULT_VERIFIER_CAPABILITIES,
): UnsupportedClaimClassification {
  if (!claim) {
    return {
      supported: false,
      behavior: 'NEEDS-VERIFY',
      reasonCodes: ['unsupported-claim-kind'],
      capability: null,
    };
  }

  const candidates = capabilities.filter((capability) => capability.claimKind === claim.kind);
  if (candidates.length === 0) {
    return {
      supported: false,
      behavior: claim.requiresRuntime ? 'HOLD' : 'NEEDS-VERIFY',
      reasonCodes: [claim.requiresRuntime ? 'runtime-required' : 'unsupported-claim-kind'],
      capability: null,
    };
  }

  const languageMatches = candidates.filter(
    (capability) =>
      !claim.language ||
      capability.supportedLanguages.length === 0 ||
      capability.supportedLanguages.includes(claim.language),
  );
  if (languageMatches.length === 0) {
    return {
      supported: false,
      behavior: candidates.some((candidate) => candidate.unsupportedBehavior === 'HOLD')
        ? 'HOLD'
        : 'NEEDS-VERIFY',
      reasonCodes: ['unsupported-language'],
      capability: candidates[0],
    };
  }

  const evidenceMatches = languageMatches.filter(
    (capability) =>
      !claim.evidenceMode || capability.supportedEvidenceModes.includes(claim.evidenceMode),
  );
  if (evidenceMatches.length === 0) {
    return {
      supported: false,
      behavior: languageMatches.some((candidate) => candidate.unsupportedBehavior === 'HOLD')
        ? 'HOLD'
        : 'NEEDS-VERIFY',
      reasonCodes: ['unsupported-evidence-mode'],
      capability: languageMatches[0],
    };
  }

  const capability = evidenceMatches[0];
  if (capability.runtimeRequired || claim.requiresRuntime) {
    return {
      supported: false,
      behavior: 'HOLD',
      reasonCodes: ['runtime-required'],
      capability,
    };
  }

  return {
    supported: true,
    behavior: 'NEEDS-VERIFY',
    reasonCodes: [],
    capability,
  };
}
