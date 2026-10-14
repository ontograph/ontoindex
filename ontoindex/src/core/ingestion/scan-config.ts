/** Default discovery skip cap — large files are usually generated/vendored and crash tree-sitter. */
const DEFAULT_MAX_FILE_SIZE = 512 * 1024;

export function getScanMaxFileSizeBytes(): number | null {
  const raw = process.env.ONTOINDEX_SCAN_MAX_FILE_KB;
  if (raw == null || raw.trim() === '') return DEFAULT_MAX_FILE_SIZE;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_FILE_SIZE;
  return value === 0 ? null : Math.floor(value * 1024);
}
