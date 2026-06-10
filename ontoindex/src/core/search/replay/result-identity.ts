export const RETRIEVAL_REPLAY_IDENTITY_KINDS = [
  'symbol',
  'process',
  'file',
  'doc-section',
  'route',
  'unknown',
] as const;

export type RetrievalReplayIdentityKind = (typeof RETRIEVAL_REPLAY_IDENTITY_KINDS)[number];

export interface RetrievalReplayIdentity {
  kind: RetrievalReplayIdentityKind;
  uid?: string;
  repoPath?: string;
  filePath?: string;
  name?: string;
  signatureHash?: string;
  docPath?: string;
  headingPath?: readonly string[];
  reason?: string;
}

export interface RetrievalReplayIdentityValidationError {
  path: string;
  message: string;
}

export type RetrievalReplayIdentityValidationResult =
  | { ok: true; identity: RetrievalReplayIdentity }
  | { ok: false; errors: RetrievalReplayIdentityValidationError[] };

const RETRIEVAL_REPLAY_IDENTITY_KIND_SET = new Set<string>(
  RETRIEVAL_REPLAY_IDENTITY_KINDS as readonly string[],
);

export function toReplayIdentityKey(identity: RetrievalReplayIdentity): string {
  const headingPath = normalizeHeadingPath(identity.headingPath);
  const base = [
    identity.uid,
    identity.repoPath,
    identity.filePath,
    identity.name,
    identity.signatureHash,
  ].map(coalesceStringForKey);

  if (identity.kind === 'doc-section') {
    return [
      'doc-section',
      coalesceStringForKey(identity.docPath),
      headingPath.join('/'),
      ...base,
      coalesceStringForKey(identity.reason),
    ]
      .filter((part) => part.length > 0)
      .join('|');
  }

  if (identity.kind === 'route') {
    return [
      'route',
      ...base,
      coalesceStringForKey(identity.reason),
    ].join('|');
  }

  if (identity.kind === 'unknown') {
    return ['unknown', coalesceStringForKey(identity.reason), ...base].join('|');
  }

  return [identity.kind, ...base, ...headingPath].join('|');
}

export function compareReplayIdentitiesByKey(
  left: RetrievalReplayIdentity,
  right: RetrievalReplayIdentity,
): number {
  return toReplayIdentityKey(left).localeCompare(toReplayIdentityKey(right));
}

export function sortReplayIdentities(
  identities: readonly RetrievalReplayIdentity[],
): RetrievalReplayIdentity[] {
  return [...identities].sort(compareReplayIdentitiesByKey);
}

export function normalizeReplayIdentities(
  identities: readonly RetrievalReplayIdentity[],
): RetrievalReplayIdentity[] {
  const canonical = identities.map(normalizeReplayIdentity);
  const deduped = new Map<string, RetrievalReplayIdentity>();

  for (const identity of canonical) {
    deduped.set(toReplayIdentityKey(identity), identity);
  }

  return sortReplayIdentities(Array.from(deduped.values()));
}

export function normalizeReplayIdentity(
  identity: RetrievalReplayIdentity,
): RetrievalReplayIdentity {
  return {
    kind: identity.kind,
    uid: coalesceString(identity.uid),
    repoPath: coalesceString(identity.repoPath),
    filePath: coalesceString(identity.filePath),
    name: coalesceString(identity.name),
    signatureHash: coalesceString(identity.signatureHash),
    docPath: coalesceString(identity.docPath),
    reason: coalesceString(identity.reason),
    headingPath: normalizeHeadingPath(identity.headingPath),
  };
}

export function isReplayIdentityStrictMatch(
  actual: RetrievalReplayIdentity,
  expected: RetrievalReplayIdentity,
): boolean {
  if (actual.kind === 'unknown' || expected.kind === 'unknown') {
    return (
      actual.kind === expected.kind &&
      toReplayIdentityKey(normalizeReplayIdentity(actual)) ===
        toReplayIdentityKey(normalizeReplayIdentity(expected))
    );
  }

  return (
    actual.kind === expected.kind &&
    toReplayIdentityKey(normalizeReplayIdentity(actual)) ===
      toReplayIdentityKey(normalizeReplayIdentity(expected))
  );
}

export function validateRetrievalReplayIdentity(
  value: unknown,
  path = 'identity',
): RetrievalReplayIdentityValidationResult {
  if (!isRecord(value)) {
    return { ok: false, errors: [{ path, message: 'must be an object' }] };
  }
  const record = value as Record<string, unknown>;

  const kind = getStringField(record, `${path}.kind`);
  if (!kind || !RETRIEVAL_REPLAY_IDENTITY_KIND_SET.has(kind)) {
    return {
      ok: false,
      errors: [
        {
          path: `${path}.kind`,
          message: `kind must be one of ${RETRIEVAL_REPLAY_IDENTITY_KINDS.join(', ')}`,
        },
      ],
    };
  }

  const errors: RetrievalReplayIdentityValidationError[] = [];
  const uid = coalesceString(record.uid);
  const repoPath = coalesceString(record.repoPath);
  const filePath = coalesceString(record.filePath);
  const name = coalesceString(record.name);
  const signatureHash = coalesceString(record.signatureHash);
  const docPath = coalesceString(record.docPath);
  const reason = coalesceString(record.reason);
  const headingPath = parseHeadingPath(record.headingPath, `${path}.headingPath`, errors);

  if (kind === 'symbol') {
    if (!uid && !filePath && !signatureHash) {
      errors.push({
        path,
        message: 'symbol identity must include uid, filePath, or signatureHash',
      });
    }
  } else if (kind === 'route') {
    if (!uid && !filePath && !name) {
      errors.push({
        path,
        message: 'route identity must include uid, filePath, or name',
      });
    }
  } else if (kind === 'process') {
    if (!uid && !filePath && !name) {
      errors.push({
        path,
        message: 'process identity must include uid, filePath, or name',
      });
    }
  } else if (kind === 'file') {
    if (!filePath) {
      errors.push({ path, message: 'file identity must include filePath' });
    }
  } else if (kind === 'doc-section') {
    if (!docPath) {
      errors.push({ path, message: 'doc-section identity must include docPath' });
    }
  } else if (kind === 'unknown') {
    if (!reason) {
      errors.push({ path, message: 'unknown identity must include reason' });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    identity: normalizeReplayIdentity({
      kind,
      uid,
      repoPath,
      filePath,
      name,
      signatureHash,
      docPath,
      headingPath,
      reason,
    }),
  };
}

function parseHeadingPath(
  value: unknown,
  path: string,
  errors: RetrievalReplayIdentityValidationError[],
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'must be an array of strings' });
    return [];
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      errors.push({ path: `${path}[${index}]`, message: 'must be a string' });
      continue;
    }
    const normalized = item.trim();
    if (normalized.length > 0) {
      out.push(normalized);
    }
  }
  return out;
}

function getStringField(record: Record<string, unknown>, path: string): RetrievalReplayIdentityKind | undefined {
  const raw = record[path.split('.').pop() as string];
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return (value.length > 0 ? value : undefined) as RetrievalReplayIdentityKind | undefined;
}

function coalesceString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function normalizeHeadingPath(value: readonly string[] | undefined): readonly string[] {
  if (!value || value.length === 0) return [];
  return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function coalesceStringForKey(value: string | undefined): string {
  return value ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
