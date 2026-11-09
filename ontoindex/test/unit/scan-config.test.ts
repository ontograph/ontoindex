import { afterEach, describe, expect, it, vi } from 'vitest';
import { getScanMaxFileSizeBytes } from '../../src/core/ingestion/scan-config.js';

afterEach(() => vi.unstubAllEnvs());

describe('scan file size policy', () => {
  it.each([undefined, '', '0', '1', '512', '-1', 'invalid', 'Infinity'])(
    'does not cap discovery with legacy override %s',
    (value) => {
      vi.stubEnv('ONTOINDEX_SCAN_MAX_FILE_KB', value);
      expect(getScanMaxFileSizeBytes()).toBeNull();
    },
  );
});
