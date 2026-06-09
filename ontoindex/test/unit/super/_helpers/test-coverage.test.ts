/**
 * Unit tests for _helpers/test-coverage.ts (Phase 2 W2-helper).
 *
 * All external primitives are mocked so tests run without a live DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the import under test.
// ---------------------------------------------------------------------------

vi.mock('../../../../src/core/lbug/pool-adapter.js', () => ({
  executeParameterized: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { executeParameterized } from '../../../../src/core/lbug/pool-adapter.js';
import { findTestFiles } from '../../../../src/mcp/super/_helpers/test-coverage.js';

const mockExecuteParameterized = executeParameterized as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ID = 'test-repo';
const SYMBOL_FILE = 'src/auth/token.ts';
const SYMBOL_NAME = 'parseToken';

function testFileRow(path: string): any {
  return { testPath: path };
}

function coFileRow(path: string): any {
  return { coPath: path };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findTestFiles', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns HIGH when 3 or more test files import the symbol file', async () => {
    // First call: IMPORTS query → 3 test files
    mockExecuteParameterized.mockResolvedValueOnce([
      testFileRow('test/unit/auth/token.test.ts'),
      testFileRow('test/integration/auth.test.ts'),
      testFileRow('test/e2e/spec/login.spec.ts'),
    ]);

    const result = await findTestFiles(REPO_ID, SYMBOL_FILE, SYMBOL_NAME);

    expect(result.likelihoodOfCoverage).toBe('HIGH');
    expect(result.coveringTests).toHaveLength(3);
    expect(result.coveringTests).toContain('test/unit/auth/token.test.ts');
  });

  it('returns MEDIUM when 1-2 test files import the symbol file', async () => {
    // First call: IMPORTS query → 2 test files
    mockExecuteParameterized.mockResolvedValueOnce([
      testFileRow('test/unit/auth/token.test.ts'),
      testFileRow('test/integration/auth.test.ts'),
    ]);

    const result = await findTestFiles(REPO_ID, SYMBOL_FILE, SYMBOL_NAME);

    expect(result.likelihoodOfCoverage).toBe('MEDIUM');
    expect(result.coveringTests).toHaveLength(2);
  });

  it('returns LOW when no test files import but co-change with test file exists', async () => {
    // First call: IMPORTS query → 0 results
    mockExecuteParameterized.mockResolvedValueOnce([]);
    // Second call: CO_CHANGED_WITH query → 1 test file co-changed
    mockExecuteParameterized.mockResolvedValueOnce([coFileRow('test/unit/auth/token.test.ts')]);

    const result = await findTestFiles(REPO_ID, SYMBOL_FILE, SYMBOL_NAME);

    expect(result.likelihoodOfCoverage).toBe('LOW');
    expect(result.coveringTests).toContain('test/unit/auth/token.test.ts');
  });

  it('returns NONE when no test files found at all', async () => {
    // First call: IMPORTS query → 0 results
    mockExecuteParameterized.mockResolvedValueOnce([]);
    // Second call: CO_CHANGED_WITH query → 0 results
    mockExecuteParameterized.mockResolvedValueOnce([]);

    const result = await findTestFiles(REPO_ID, SYMBOL_FILE, SYMBOL_NAME);

    expect(result.likelihoodOfCoverage).toBe('NONE');
    expect(result.coveringTests).toHaveLength(0);
  });

  it('returns NONE and does not throw when Cypher throws on IMPORTS query', async () => {
    // First call: IMPORTS query → throws
    mockExecuteParameterized.mockRejectedValueOnce(new Error('Cypher error'));

    const result = await findTestFiles(REPO_ID, SYMBOL_FILE, SYMBOL_NAME);

    expect(result.likelihoodOfCoverage).toBe('NONE');
    expect(result.coveringTests).toHaveLength(0);
  });

  it('still returns LOW when CO_CHANGED_WITH throws (falls back to NONE)', async () => {
    // First call: IMPORTS query → 0 results
    mockExecuteParameterized.mockResolvedValueOnce([]);
    // Second call: CO_CHANGED_WITH query → throws (best-effort ignored)
    mockExecuteParameterized.mockRejectedValueOnce(new Error('network error'));

    const result = await findTestFiles(REPO_ID, SYMBOL_FILE, SYMBOL_NAME);

    expect(result.likelihoodOfCoverage).toBe('NONE');
    expect(result.coveringTests).toHaveLength(0);
  });
});
