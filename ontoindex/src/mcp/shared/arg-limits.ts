/** Longest accepted string argument; `ONTOINDEX_MAX_ARG_CHARS` (1024..67108864) overrides it. */
export function resolveMaxArgChars(): number {
  const configuredLimit = process.env.ONTOINDEX_MAX_ARG_CHARS;
  const parsedLimit =
    configuredLimit && /^\d+$/.test(configuredLimit) ? Number(configuredLimit) : NaN;
  return Number.isInteger(parsedLimit) && parsedLimit >= 1024 && parsedLimit <= 67_108_864
    ? parsedLimit
    : 2_097_152;
}

/** First top-level string (or string array item) over the limit, for every tool kind. */
export function findOversizedArgument(params: Record<string, unknown>): string | undefined {
  const limit = resolveMaxArgChars();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > limit)
      return `${key}: string longer than ${limit} characters`;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const item = value[index];
        if (typeof item === 'string' && item.length > limit)
          return `${key}[${index}]: string longer than ${limit} characters`;
      }
    }
  }
  return undefined;
}
