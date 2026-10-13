/** Longest accepted string argument; `ONTOINDEX_MAX_ARG_CHARS` (1024..67108864) overrides it. */
export function resolveMaxArgChars(): number {
  const configuredLimit = process.env.ONTOINDEX_MAX_ARG_CHARS;
  const parsedLimit =
    configuredLimit && /^\d+$/.test(configuredLimit) ? Number(configuredLimit) : NaN;
  return Number.isInteger(parsedLimit) && parsedLimit >= 1024 && parsedLimit <= 67_108_864
    ? parsedLimit
    : 2_097_152;
}

/** Maximum array items; ONTOINDEX_MAX_ARG_ITEMS (1..65536) overrides it. */
export function resolveMaxArgItems(): number {
  const configuredLimit = process.env.ONTOINDEX_MAX_ARG_ITEMS;
  const parsedLimit =
    configuredLimit && /^\d+$/.test(configuredLimit) ? Number(configuredLimit) : NaN;
  return Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 65_536
    ? parsedLimit
    : 256;
}

/** First oversized top-level argument or aggregate JSON payload, for every tool kind. */
export function findOversizedArgument(params: Record<string, unknown>): string | undefined {
  const limit = resolveMaxArgChars();
  const itemLimit = resolveMaxArgItems();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > limit)
      return `${key}: string longer than ${limit} characters`;
    if (Array.isArray(value)) {
      if (value.length > itemLimit) return `${key}: array longer than ${itemLimit} items`;
      for (let index = 0; index < value.length; index += 1) {
        const item = value[index];
        if (typeof item === 'string' && item.length > limit)
          return `${key}[${index}]: string longer than ${limit} characters`;
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(params), 'utf8') > 1_048_576)
    return 'arguments: JSON larger than 1048576 bytes';
  return undefined;
}
