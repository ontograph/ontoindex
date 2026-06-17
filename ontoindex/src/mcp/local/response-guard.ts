export const RESPONSE_GUARD_MAX_BYTES = 512 * 1024;
export const RESPONSE_GUARD_RETRY_HINT = 'Reduce limit or add filters';

export function guardResponseSize(payload: string): string {
  const estimatedBytes = Buffer.byteLength(payload, 'utf8');
  if (estimatedBytes <= RESPONSE_GUARD_MAX_BYTES) return payload;
  return JSON.stringify({
    truncated: true,
    responseBudget: {
      mode: 'guarded-preview',
      estimatedBytes,
      truncated: true,
      retryHint: RESPONSE_GUARD_RETRY_HINT,
    },
    hint: RESPONSE_GUARD_RETRY_HINT,
    preview: payload.slice(0, 2000),
  });
}
