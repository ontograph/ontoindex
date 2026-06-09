/**
 * Unit tests for gn_propose_location super-function (Phase 4 W4c).
 *
 * All external primitives (gnExplore, executeParameterized, fs/promises)
 * are mocked so tests run without a live DB or filesystem access.
 */

import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before imports under test (vi.mock is hoisted).
// ---------------------------------------------------------------------------

vi.mock('../../../src/mcp/super/explore.js', () => ({
  gnExplore: vi.fn(),
}));

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  access: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { gnExplore } from '../../../src/mcp/super/explore.js';
import { executeParameterized } from '../../../src/core/lbug/pool-adapter.js';
import { access, readFile, realpath, stat } from 'fs/promises';
import { gnProposeLocation } from '../../../src/mcp/super/propose-location.js';

const mockGnExplore = gnExplore as unknown as ReturnType<typeof vi.fn>;
const mockExecuteParameterized = executeParameterized as unknown as ReturnType<typeof vi.fn>;
const mockAccess = access as unknown as ReturnType<typeof vi.fn>;
const mockRealpath = realpath as unknown as ReturnType<typeof vi.fn>;
const mockStat = stat as unknown as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>;
const normalizePath = (value: unknown) => String(value).replace(/\\/g, '/');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_ID = process.cwd();

function makeExploreResult(
  clusters: Array<{ name: string; role: string; fileCount: number; keyFiles: string[] }>,
) {
  return {
    version: 1 as const,
    query: {
      original: 'add auth handler',
      classified: { intent: 'nl-conceptual' as const, confidence: 0.8 },
    },
    topProcesses: [],
    topSymbols: [],
    clusters,
    suggestedEntryPoints: [],
    warnings: [],
  };
}

/** Return a stub sibling-file query result for a given list of paths. */
function siblingRows(paths: string[]): any[] {
  return paths.map((fp) => ({ fp }));
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  mockAccess.mockRejectedValue(new Error('ENOENT'));
  mockRealpath.mockImplementation(async (fp: string) => fp);
  mockStat.mockResolvedValue({ isFile: () => true, size: 0 });
  mockReadFile.mockRejectedValue(new Error('ENOENT'));
  // Default: sibling query returns empty
  mockExecuteParameterized.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gnProposeLocation', () => {
  // ---- Test 1: top-3 clusters produce top-3 candidates --------------------

  it('returns up to 3 candidates — one per top cluster', async () => {
    const clusters = [
      { name: 'auth', role: 'security', fileCount: 5, keyFiles: [] },
      { name: 'api', role: 'transport', fileCount: 8, keyFiles: [] },
      { name: 'middleware', role: 'routing', fileCount: 3, keyFiles: [] },
    ];
    mockGnExplore.mockResolvedValue(makeExploreResult(clusters));

    const report = await gnProposeLocation(REPO_ID, { intent: 'add auth handler' });

    expect(report.version).toBe(1);
    expect(report.candidates).toHaveLength(3);
    expect(report.candidates.map((c) => c.matchedCluster)).toEqual(['auth', 'api', 'middleware']);
  });

  // ---- Test 2: longest common directory derived from sibling paths ---------

  it('derives the longest common directory from sibling file paths', async () => {
    const clusters = [{ name: 'auth-cluster', role: 'security', fileCount: 3, keyFiles: [] }];
    mockGnExplore.mockResolvedValue(makeExploreResult(clusters));

    // First call (name), second call (heuristicLabel fallback not needed here)
    mockExecuteParameterized.mockResolvedValueOnce(
      siblingRows([
        'src/auth/login-service.ts',
        'src/auth/logout-service.ts',
        'src/auth/token-service.ts',
      ]),
    );

    const report = await gnProposeLocation(REPO_ID, { intent: 'add new auth handler' });

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].directory).toBe('src/auth');
    expect(report.candidates[0].siblingFiles).toHaveLength(3);
  });

  // ---- Test 3: naming pattern detected (common suffix) --------------------

  it('detects common filename suffix from sibling files', async () => {
    const clusters = [{ name: 'services', role: 'business-logic', fileCount: 4, keyFiles: [] }];
    mockGnExplore.mockResolvedValue(makeExploreResult(clusters));

    mockExecuteParameterized.mockResolvedValueOnce(
      siblingRows([
        'src/services/user-service.ts',
        'src/services/order-service.ts',
        'src/services/payment-service.ts',
        'src/services/notification-service.ts',
      ]),
    );

    const report = await gnProposeLocation(REPO_ID, { intent: 'add email notification service' });

    expect(report.candidates).toHaveLength(1);
    // The suggested filename should incorporate the detected '-service.ts' suffix
    expect(report.candidates[0].suggestedFilename).toMatch(/-service\.ts$/);
  });

  // ---- Test 4: filename derived from intent keywords + detected pattern ----

  it('generates suggested filename from intent keywords and naming pattern', async () => {
    const clusters = [{ name: 'handlers', role: 'api', fileCount: 3, keyFiles: [] }];
    mockGnExplore.mockResolvedValue(makeExploreResult(clusters));

    mockExecuteParameterized.mockResolvedValueOnce(
      siblingRows([
        'src/handlers/user.handler.ts',
        'src/handlers/order.handler.ts',
        'src/handlers/product.handler.ts',
      ]),
    );

    const report = await gnProposeLocation(REPO_ID, { intent: 'implement payment handler' });

    expect(report.candidates).toHaveLength(1);
    const { suggestedFilename } = report.candidates[0];
    // Should contain meaningful intent keywords (not stop words like "implement")
    expect(suggestedFilename).toMatch(/payment/);
  });

  // ---- Test 5: no clusters → warning + empty candidates -------------------

  it('returns empty candidates and a warning when no clusters are found', async () => {
    mockGnExplore.mockResolvedValue(makeExploreResult([]));

    const report = await gnProposeLocation(REPO_ID, { intent: 'do something unusual' });

    expect(report.version).toBe(1);
    expect(report.candidates).toHaveLength(0);
    expect(report.warnings.some((w) => w.includes('no clusters found'))).toBe(true);
  });

  // ---- Test 6: explore failure → warning + empty candidates ---------------

  it('returns empty candidates and a warning when gnExplore throws', async () => {
    mockGnExplore.mockRejectedValue(new Error('backend unavailable'));

    const report = await gnProposeLocation(REPO_ID, { intent: 'add cache layer' });

    expect(report.candidates).toHaveLength(0);
    expect(report.warnings.some((w) => w.includes('backend unavailable'))).toBe(true);
  });

  // ---- Test 7: importPattern extracted from readable sibling files ---------

  it('extracts common import patterns from sibling files when readable', async () => {
    const clusters = [{ name: 'services', role: 'logic', fileCount: 2, keyFiles: [] }];
    mockGnExplore.mockResolvedValue(makeExploreResult(clusters));

    mockExecuteParameterized.mockResolvedValueOnce(
      siblingRows(['src/services/user-service.ts', 'src/services/order-service.ts']),
    );

    // Simulate readable sibling files with common imports
    mockAccess.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ isFile: () => true, size: 128 });
    mockReadFile.mockImplementation((fp: string) => {
      if (normalizePath(fp).endsWith('src/services/user-service.ts')) {
        return Promise.resolve(
          `import { db } from '../db/client.js';\nimport { logger } from '../utils/logger.js';\n`,
        );
      }
      if (normalizePath(fp).endsWith('src/services/order-service.ts')) {
        return Promise.resolve(
          `import { db } from '../db/client.js';\nimport { validator } from '../utils/validator.js';\n`,
        );
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const report = await gnProposeLocation(REPO_ID, { intent: 'add user order service' });

    expect(report.candidates).toHaveLength(1);
    // The most-common import (db client, appears in both files) should be present
    expect(report.candidates[0].importPattern).toBeDefined();
    expect(report.candidates[0].importPattern).toContain("import { db } from '../db/client.js';");
  });

  // ---- Test 8: language param 'python' influences default extension --------

  it("uses '.py' extension when language is 'python' and no naming pattern found", async () => {
    const clusters = [{ name: 'scripts', role: 'util', fileCount: 1, keyFiles: [] }];
    mockGnExplore.mockResolvedValue(makeExploreResult(clusters));

    // Single sibling — no strong naming pattern
    mockExecuteParameterized.mockResolvedValueOnce(siblingRows(['scripts/setup.py']));

    const report = await gnProposeLocation(REPO_ID, {
      intent: 'add data migration script',
      language: 'python',
    });

    expect(report.candidates).toHaveLength(1);
    // With only one sibling the suffix detection threshold isn't met,
    // so the language fallback '.py' should be used.
    expect(report.candidates[0].suggestedFilename).toMatch(/\.py$/);
  });

  it('skips sibling imports that resolve outside the repo', async () => {
    const clusters = [{ name: 'services', role: 'logic', fileCount: 1, keyFiles: [] }];
    mockGnExplore.mockResolvedValue(makeExploreResult(clusters));
    mockExecuteParameterized.mockResolvedValueOnce(siblingRows(['../outside/secret.ts']));
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("import { secret } from '../secret.js';\n");

    const report = await gnProposeLocation(REPO_ID, { intent: 'add private service' });

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].importPattern).toBeUndefined();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('skips sibling imports when realpath escapes the repo', async () => {
    const clusters = [{ name: 'services', role: 'logic', fileCount: 1, keyFiles: [] }];
    mockGnExplore.mockResolvedValue(makeExploreResult(clusters));
    mockExecuteParameterized.mockResolvedValueOnce(siblingRows(['src/services/linked.ts']));
    mockAccess.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ isFile: () => true, size: 128 });
    mockReadFile.mockResolvedValue("import { secret } from '../secret.js';\n");
    mockRealpath.mockImplementation(async (fp: string) =>
      normalizePath(fp).endsWith('/src/services/linked.ts')
        ? path.resolve(process.cwd(), '..', 'outside', 'linked.ts')
        : fp,
    );

    const report = await gnProposeLocation(REPO_ID, { intent: 'add private service' });

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].importPattern).toBeUndefined();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('does not read import-pattern files over the size limit', async () => {
    const clusters = [{ name: 'services', role: 'logic', fileCount: 1, keyFiles: [] }];
    mockGnExplore.mockResolvedValue(makeExploreResult(clusters));
    mockExecuteParameterized.mockResolvedValueOnce(siblingRows(['src/services/large.ts']));
    mockAccess.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ isFile: () => true, size: 512 * 1024 + 1 });
    mockReadFile.mockResolvedValue("import { db } from '../db/client.js';\n");

    const report = await gnProposeLocation(REPO_ID, { intent: 'add large service' });

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].importPattern).toBeUndefined();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('skips import sniffing when the target repo root is unknown', async () => {
    const clusters = [{ name: 'services', role: 'logic', fileCount: 1, keyFiles: [] }];
    mockGnExplore.mockResolvedValue(makeExploreResult(clusters));
    mockExecuteParameterized.mockResolvedValueOnce(siblingRows(['src/services/user-service.ts']));
    mockAccess.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ isFile: () => true, size: 128 });
    mockReadFile.mockResolvedValue("import { db } from '../db/client.js';\n");

    const report = await gnProposeLocation('other-indexed-repo', { intent: 'add service' });

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].importPattern).toBeUndefined();
    expect(report.warnings).toContain(
      'import pattern sniffing skipped: target repo root is unknown',
    );
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('uses import sniffing for current repo id with different casing', async () => {
    const clusters = [{ name: 'services', role: 'logic', fileCount: 1, keyFiles: [] }];
    mockGnExplore.mockResolvedValue(makeExploreResult(clusters));
    mockExecuteParameterized.mockResolvedValueOnce(siblingRows(['src/services/user-service.ts']));
    mockAccess.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ isFile: () => true, size: 128 });
    mockReadFile.mockResolvedValue("import { db } from '../db/client.js';\n");

    const currentRepoId = process.cwd().split(/[\\/]/).pop()!.toLowerCase();
    const report = await gnProposeLocation(currentRepoId, { intent: 'add service' });

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].importPattern).toContain("import { db } from '../db/client.js';");
    expect(report.warnings).not.toContain(
      'import pattern sniffing skipped: target repo root is unknown',
    );
  });
});
