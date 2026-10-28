export type LbugOpenErrorKind =
  | 'lock'
  | 'resource'
  | 'permission'
  | 'corrupt'
  | 'incompatible'
  | 'unknown';

/** Diagnostics used by the pool's existing lock retry and WAL recovery policy. */
export function classifyLbugOpenDiagnostic(message: string): 'lock' | 'wal' | 'other' {
  if (
    /Could not set lock/i.test(message) ||
    /\b(file|database|db)\s+lock\b|\block\s+(held|file|conflict)\b/i.test(message) ||
    /resource temporarily unavailable|\b(EAGAIN|EWOULDBLOCK)\b/i.test(message)
  )
    return 'lock';
  if (
    /\bwal\b/i.test(message) &&
    /corrupt|checksum|replay|past the end of the file|truncat/i.test(message)
  )
    return 'wal';
  return 'other';
}

const NATIVE_READ_FAILURE = /reading past the end of the file|cannot read from file/i;

export function classifyLbugOpenError(error: unknown): LbugOpenErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const diagnostic = `${code} ${message}`;
  if (classifyLbugOpenDiagnostic(diagnostic) === 'lock') return 'lock';
  if (/\b(ENOMEM|EMFILE|ENFILE)\b|allocation|out of memory/i.test(diagnostic)) return 'resource';
  if (/\b(EACCES|EPERM)\b/i.test(diagnostic)) return 'permission';
  if (
    /corrupt|checksum|truncated|malformed database|invalid database file|not a valid [\w-]* ?database file/i.test(
      message,
    )
  )
    return 'corrupt';
  if (NATIVE_READ_FAILURE.test(message) && classifyLbugOpenDiagnostic(diagnostic) !== 'wal')
    return 'corrupt';
  if (/storage version|incompatible|unsupported version|version mismatch/i.test(message))
    return 'incompatible';
  return 'unknown';
}

export class LbugOpenError extends Error {
  declare readonly cause: unknown;
  readonly phase = 'native-open' as const;
  readonly kind: LbugOpenErrorKind;

  constructor(
    readonly dbPath: string,
    cause: unknown,
    message = cause instanceof Error ? cause.message : String(cause),
  ) {
    super(message, { cause });
    this.name = 'LbugOpenError';
    this.kind = classifyLbugOpenError(cause);
  }
}
