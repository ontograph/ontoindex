/** Read a named query result value, falling back to its positional column. */
export function queryRowValue(
  row: Readonly<Record<string, unknown>> | readonly unknown[],
  key: string,
  index: number,
): unknown {
  const record = row as Readonly<Record<string, unknown>>;
  return record[key] ?? (Array.isArray(row) ? row[index] : record[String(index)]);
}
