/** Node timers accept delays up to a signed 32-bit integer. */
export function analysisTimeoutMs(value: string | undefined): number {
  const fallback = 30 * 60 * 1000;
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647
    ? parsed
    : fallback;
}
