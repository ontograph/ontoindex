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
    : 1024;
}

/** Maximum serialized argument bytes; ONTOINDEX_MAX_ARG_TOTAL_BYTES (1024..134217728) overrides it. */
export function resolveMaxArgTotalBytes(): number {
  const configuredLimit = process.env.ONTOINDEX_MAX_ARG_TOTAL_BYTES;
  const parsedLimit =
    configuredLimit && /^\d+$/.test(configuredLimit) ? Number(configuredLimit) : NaN;
  return Number.isInteger(parsedLimit) && parsedLimit >= 1024 && parsedLimit <= 134_217_728
    ? parsedLimit
    : Math.max(4 * 1024 * 1024, 2 * resolveMaxArgChars() + 1024 * 1024);
}

/** First oversized top-level argument or aggregate JSON payload, for every tool kind. */
export function findOversizedArgument(params: Record<string, unknown>): string | undefined {
  const limit = resolveMaxArgChars();
  const itemLimit = resolveMaxArgItems();
  const totalLimit = resolveMaxArgTotalBytes();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > limit)
      return `${key}: string longer than ${limit} characters`;
    if (Array.isArray(value)) {
      if (value.length > itemLimit)
        return `${key}: array longer than ${itemLimit} items (raise ONTOINDEX_MAX_ARG_ITEMS)`;
      for (let index = 0; index < value.length; index += 1) {
        const item = value[index];
        if (typeof item === 'string' && item.length > limit)
          return `${key}[${index}]: string longer than ${limit} characters`;
      }
    }
  }
  const serialized = JSON.stringify(params);
  if (Buffer.byteLength(serialized, 'utf8') > totalLimit)
    return `arguments: JSON larger than ${totalLimit} bytes (raise ONTOINDEX_MAX_ARG_TOTAL_BYTES)`;
  return undefined;
}
