/** Escape a value for a single-quoted LadybugDB string literal (backslash first, then quote). */
export const quoteLbugString = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
