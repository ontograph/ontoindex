const MAX_BYTES = 512 * 1024;

export function guardResponseSize(payload: string): string {
  if (Buffer.byteLength(payload, 'utf8') <= MAX_BYTES) return payload;
  return JSON.stringify({
    truncated: true,
    hint: 'Reduce limit or add filters',
    preview: payload.slice(0, 2000),
  });
}
