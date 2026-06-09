export const normalizeLimit = (n: unknown, dflt = 50, max = 500): number =>
  Math.min(Math.max(Math.floor(Number(n) || dflt), 1), max);
