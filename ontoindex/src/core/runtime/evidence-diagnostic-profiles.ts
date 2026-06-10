import {
  assertEvidenceDiagnosticCategory,
  assertEvidenceDiagnosticKind,
  isEvidenceDiagnosticTruncationReason,
  type EvidenceDiagnosticAuthority,
  type EvidenceDiagnosticQualityKind,
  type EvidenceDiagnosticRecord,
} from './evidence-diagnostics.js';

export interface EvidenceDiagnosticSurfaceProfile {
  id: string;
  allowedCategories?: readonly string[];
  allowedSources?: readonly string[];
  allowedAuthorities?: readonly EvidenceDiagnosticAuthority[];
  allowedKinds?: readonly EvidenceDiagnosticQualityKind[];
  requireReason?: boolean;
  requireFreshnessForAuthoritative?: boolean;
  requireTruncationDiagnosticWhenBounded?: boolean;
}

export interface EvidenceDiagnosticProfileInput {
  profile: EvidenceDiagnosticSurfaceProfile;
  diagnostics: readonly EvidenceDiagnosticRecord[];
  boundedOutput?: {
    evidenceOmitted?: boolean;
    omittedEvidenceCount?: number;
  };
}

export type EvidenceDiagnosticProfileViolationKind =
  | 'category-not-allowed'
  | 'source-not-allowed'
  | 'authority-not-allowed'
  | 'kind-not-allowed'
  | 'missing-reason'
  | 'missing-authoritative-freshness'
  | 'missing-truncation-diagnostic';

export interface EvidenceDiagnosticProfileViolation {
  kind: EvidenceDiagnosticProfileViolationKind;
  profileId: string;
  subject: string;
  source: string;
  category: string;
  qualityKind: string;
  authority: string;
  reason: string;
}

export interface EvidenceDiagnosticProfileReport {
  profileId: string;
  violations: EvidenceDiagnosticProfileViolation[];
  summary: {
    total: number;
    byKind: Record<EvidenceDiagnosticProfileViolationKind, number>;
  };
}

const VIOLATION_KINDS: readonly EvidenceDiagnosticProfileViolationKind[] = [
  'category-not-allowed',
  'source-not-allowed',
  'authority-not-allowed',
  'kind-not-allowed',
  'missing-reason',
  'missing-authoritative-freshness',
  'missing-truncation-diagnostic',
] as const;

const VIOLATION_KIND_ORDER = VIOLATION_KINDS.reduce(
  (order, kind, index) => {
    order.set(kind, index);
    return order;
  },
  new Map<EvidenceDiagnosticProfileViolationKind, number>(),
);

export function evaluateEvidenceDiagnosticProfile(
  input: EvidenceDiagnosticProfileInput,
): EvidenceDiagnosticProfileReport {
  const { profile, diagnostics } = input;

  const categoryAllowlist = profile.allowedCategories ? new Set(profile.allowedCategories) : undefined;
  const sourceAllowlist = profile.allowedSources ? new Set(profile.allowedSources) : undefined;
  const authorityAllowlist = profile.allowedAuthorities
    ? new Set(profile.allowedAuthorities)
    : undefined;
  const kindAllowlist = profile.allowedKinds ? new Set(profile.allowedKinds) : undefined;

  const violations: EvidenceDiagnosticProfileViolation[] = [];
  const orderedViolationKind = (kind: EvidenceDiagnosticProfileViolationKind): number =>
    VIOLATION_KIND_ORDER.get(kind) ?? Number.MAX_SAFE_INTEGER;

  for (const diagnostic of diagnostics) {
    const perDiagnosticViolations: EvidenceDiagnosticProfileViolation[] = [];

    if (categoryAllowlist && !categoryAllowlist.has(diagnostic.category)) {
      perDiagnosticViolations.push(
        violation({
          kind: 'category-not-allowed',
          profileId: profile.id,
          subject: diagnostic.subject,
          source: diagnostic.source,
          category: diagnostic.category,
          qualityKind: String(diagnostic.kind),
          authority: String(diagnostic.authority),
          reason: `category "${diagnostic.category}" is not allowed by profile "${profile.id}"`,
        }),
      );
    }

    if (sourceAllowlist && !sourceAllowlist.has(diagnostic.source)) {
      perDiagnosticViolations.push(
        violation({
          kind: 'source-not-allowed',
          profileId: profile.id,
          subject: diagnostic.subject,
          source: diagnostic.source,
          category: diagnostic.category,
          qualityKind: String(diagnostic.kind),
          authority: String(diagnostic.authority),
          reason: `source "${diagnostic.source}" is not allowed by profile "${profile.id}"`,
        }),
      );
    }

    if (!isAuthorityValue(diagnostic.authority) || authorityAllowlist?.has(diagnostic.authority) === false) {
      perDiagnosticViolations.push(
        violation({
          kind: 'authority-not-allowed',
          profileId: profile.id,
          subject: diagnostic.subject,
          source: diagnostic.source,
          category: diagnostic.category,
          qualityKind: String(diagnostic.kind),
          authority: String(diagnostic.authority),
          reason: `authority "${String(diagnostic.authority)}" is not allowed by profile "${profile.id}"`,
        }),
      );
    }

    try {
      assertEvidenceDiagnosticCategory(String(diagnostic.category));
    } catch (error) {
      perDiagnosticViolations.push(
        violation({
          kind: 'kind-not-allowed',
          profileId: profile.id,
          subject: diagnostic.subject,
          source: diagnostic.source,
          category: diagnostic.category,
          qualityKind: String(diagnostic.kind),
          authority: String(diagnostic.authority),
          reason: reasonFromError(error),
        }),
      );
    }

    try {
      assertEvidenceDiagnosticKind(String(diagnostic.kind));
      if (kindAllowlist && !kindAllowlist.has(diagnostic.kind as EvidenceDiagnosticQualityKind)) {
        perDiagnosticViolations.push(
          violation({
            kind: 'kind-not-allowed',
            profileId: profile.id,
            subject: diagnostic.subject,
            source: diagnostic.source,
            category: diagnostic.category,
            qualityKind: String(diagnostic.kind),
            authority: String(diagnostic.authority),
            reason: `quality kind "${diagnostic.kind}" is not allowed by profile "${profile.id}"`,
          }),
        );
      }
    } catch (error) {
      perDiagnosticViolations.push(
        violation({
          kind: 'kind-not-allowed',
          profileId: profile.id,
          subject: diagnostic.subject,
          source: diagnostic.source,
          category: diagnostic.category,
          qualityKind: String(diagnostic.kind),
          authority: String(diagnostic.authority),
          reason: reasonFromError(error),
        }),
      );
    }

    if (profile.requireReason && isBlank(diagnostic.reason)) {
      perDiagnosticViolations.push(
        violation({
          kind: 'missing-reason',
          profileId: profile.id,
          subject: diagnostic.subject,
          source: diagnostic.source,
          category: diagnostic.category,
          qualityKind: String(diagnostic.kind),
          authority: String(diagnostic.authority),
          reason: 'diagnostic reason is required',
        }),
      );
    }

    if (profile.requireFreshnessForAuthoritative && diagnostic.authority === 'authoritative') {
      if (isBlank(diagnostic.freshness)) {
        perDiagnosticViolations.push(
          violation({
            kind: 'missing-authoritative-freshness',
            profileId: profile.id,
            subject: diagnostic.subject,
            source: diagnostic.source,
            category: diagnostic.category,
            qualityKind: String(diagnostic.kind),
            authority: String(diagnostic.authority),
            reason: 'authoritative diagnostics require freshness',
          }),
        );
      }
    }

    perDiagnosticViolations.sort((left, right) => {
      return orderedViolationKind(left.kind) - orderedViolationKind(right.kind);
    });
    violations.push(...perDiagnosticViolations);
  }

  if (input.profile.requireTruncationDiagnosticWhenBounded && isBoundedOmitted(input.boundedOutput)) {
    const hasTruncationDiagnostic = diagnostics.some(isTruncationDiagnostic);
    if (!hasTruncationDiagnostic) {
      violations.push(
        violation({
          kind: 'missing-truncation-diagnostic',
          profileId: profile.id,
          subject: 'bounded output',
          source: 'evidence-profile',
          category: 'truncation',
          qualityKind: 'truncated',
          authority: 'advisory',
          reason: 'bounded output without omitted evidence marker requires a truncation diagnostic',
        }),
      );
    }
  }

  return {
    profileId: profile.id,
    violations,
    summary: summarizeProfileViolations(violations),
  };
}

function summarizeProfileViolations(violations: EvidenceDiagnosticProfileViolation[]): {
  total: number;
  byKind: Record<EvidenceDiagnosticProfileViolationKind, number>;
} {
  const byKind = VIOLATION_KINDS.reduce(
    (counts, kind) => {
      counts[kind] = 0;
      return counts;
    },
    {} as Record<EvidenceDiagnosticProfileViolationKind, number>,
  );

  for (const violationRecord of violations) {
    byKind[violationRecord.kind] += 1;
  }

  return {
    total: violations.length,
    byKind,
  };
}

function violation(input: Omit<EvidenceDiagnosticProfileViolation, 'qualityKind' | 'authority'> & {
  qualityKind: string;
  authority: string;
}): EvidenceDiagnosticProfileViolation {
  return {
    ...input,
    profileId: input.profileId,
    qualityKind: input.qualityKind,
    authority: input.authority,
  };
}

function isAuthorityValue(authority: EvidenceDiagnosticAuthority | undefined): boolean {
  return authority === 'authoritative' || authority === 'advisory';
}

function isBlank(value: string | undefined): boolean {
  return !value || value.trim().length === 0;
}

function reasonFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBoundedOmitted(
  boundedOutput: EvidenceDiagnosticProfileInput['boundedOutput'],
): boolean {
  return (
    boundedOutput?.evidenceOmitted === true || (boundedOutput?.omittedEvidenceCount ?? 0) > 0
  );
}

function isTruncationDiagnostic(diagnostic: EvidenceDiagnosticRecord): boolean {
  return (
    diagnostic.truncated === true ||
    diagnostic.kind === 'truncated' ||
    isEvidenceDiagnosticTruncationReason(diagnostic.reason)
  );
}
