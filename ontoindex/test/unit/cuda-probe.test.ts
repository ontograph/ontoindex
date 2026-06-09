/**
 * Unit tests for cuda-probe.ts
 *
 * Verifies that hasOrtCudaProvider() and isCudaAvailable() behave correctly
 * under controlled conditions. Both the analyze-time and MCP query-time
 * embedders delegate to these shared functions — this test encodes the v4
 * CUDA bug contract so a fix in one path cannot silently bypass the other.
 *
 * Mocking strategy:
 *   - `fs` is mocked at module level via vi.mock so every existsSync call
 *     in cuda-probe.ts is intercepted.
 *   - `child_process` is similarly mocked so execFileSync('ldconfig', ['-p'])
 *     never shells out.
 *   - `createRequire` (from 'module') resolves a chain of package.json paths
 *     that ultimately land in an existsSync call for the CUDA .so. Mocking
 *     existsSync to return true/false is sufficient for the happy/sad paths.
 *     When createRequire itself throws (e.g. package not installed), the
 *     catch block in hasOrtCudaProvider returns false — tested via the throw
 *     variant below.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

// Mock the 'module' built-in so createRequire is controllable.
// Default: createRequire returns a require function that itself throws
// (simulates @huggingface/transformers not installed), so hasOrtCudaProvider
// catches and returns false unless the test overrides it.
vi.mock('module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('module')>();
  return {
    ...actual,
    createRequire: vi.fn(() => {
      const req: any = vi.fn(() => {
        throw new Error('Module not found (mock default)');
      });
      req.resolve = vi.fn(() => {
        throw new Error('Module not found (mock default)');
      });
      return req;
    }),
  };
});

// ── Import after mocks are registered ────────────────────────────────────────

import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { hasOrtCudaProvider, isCudaAvailable } from '../../src/core/embeddings/cuda-probe.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockExecFileSync = execFileSync as ReturnType<typeof vi.fn>;
const mockCreateRequire = createRequire as ReturnType<typeof vi.fn>;

// Builds a createRequire mock that makes the .so path check return `soExists`.
function setupCreateRequireWithSo(soExists: boolean): void {
  mockCreateRequire.mockImplementation(() => {
    const req: any = vi.fn();
    req.resolve = vi.fn((id: string) => {
      if (id === '@huggingface/transformers/package.json') return '/fake/transformers/package.json';
      if (id === 'onnxruntime-node/package.json') return '/fake/ort/package.json';
      throw new Error(`Unexpected resolve: ${id}`);
    });
    return req;
  });
  // existsSync is called for the .so path — control the return value here.
  mockExistsSync.mockReturnValue(soExists);
}

// ── Env isolation ─────────────────────────────────────────────────────────────

const ENV_KEYS = ['CUDA_PATH', 'LD_LIBRARY_PATH'] as const;

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

// ── hasOrtCudaProvider tests ──────────────────────────────────────────────────

describe('hasOrtCudaProvider', () => {
  it('returns false when existsSync returns false for the CUDA .so path', () => {
    setupCreateRequireWithSo(false);
    expect(hasOrtCudaProvider()).toBe(false);
  });

  it('returns true when existsSync returns true for the CUDA .so path', () => {
    setupCreateRequireWithSo(true);
    expect(hasOrtCudaProvider()).toBe(true);
  });

  it('returns false when module resolution throws (catch block returns false)', () => {
    // Default mock: createRequire().resolve() throws — catch returns false.
    mockCreateRequire.mockImplementation(() => {
      const req: any = vi.fn();
      req.resolve = vi.fn(() => {
        throw new Error('Cannot find module @huggingface/transformers');
      });
      return req;
    });
    expect(hasOrtCudaProvider()).toBe(false);
  });
});

// ── isCudaAvailable tests ─────────────────────────────────────────────────────

describe('isCudaAvailable', () => {
  it('returns false when hasOrtCudaProvider would return false (no ldconfig check)', () => {
    // .so does not exist → hasOrtCudaProvider() = false → short-circuit
    setupCreateRequireWithSo(false);
    const result = isCudaAvailable();
    expect(result).toBe(false);
    // ldconfig must NOT have been called
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns true when provider present AND ldconfig output includes libcublasLt.so.12', () => {
    setupCreateRequireWithSo(true);
    mockExecFileSync.mockReturnValue(
      'libcublasLt.so.12 => /usr/lib/x86_64-linux-gnu/libcublasLt.so.12',
    );
    expect(isCudaAvailable()).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'ldconfig',
      ['-p'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('returns false when provider present but ldconfig misses libcublasLt.so.12 and env vars unset', () => {
    setupCreateRequireWithSo(true);
    // ldconfig output does NOT contain the required library
    mockExecFileSync.mockReturnValue('libcublas.so.11 => /usr/lib/libcublas.so.11');
    // CUDA_PATH and LD_LIBRARY_PATH are unset (cleared in beforeEach)
    // existsSync for env-var fallback paths must return false
    // (mockExistsSync is already set to true for the .so check above — reset to false for file-path checks)
    mockExistsSync.mockReturnValue(false);
    // Re-run setupCreateRequireWithSo but keep existsSync false from here
    mockCreateRequire.mockImplementation(() => {
      const req: any = vi.fn();
      req.resolve = vi.fn((id: string) => {
        if (id === '@huggingface/transformers/package.json')
          return '/fake/transformers/package.json';
        if (id === 'onnxruntime-node/package.json') return '/fake/ort/package.json';
        throw new Error(`Unexpected: ${id}`);
      });
      return req;
    });
    // First existsSync call (for .so) must return true so hasOrtCudaProvider passes,
    // subsequent calls (for env-var lib paths) return false.
    mockExistsSync.mockReturnValueOnce(true).mockReturnValue(false);

    expect(isCudaAvailable()).toBe(false);
  });

  it('returns true via CUDA_PATH env var fallback: provider present, ldconfig misses, CUDA_PATH set', () => {
    // Provider present
    mockCreateRequire.mockImplementation(() => {
      const req: any = vi.fn();
      req.resolve = vi.fn((id: string) => {
        if (id === '@huggingface/transformers/package.json')
          return '/fake/transformers/package.json';
        if (id === 'onnxruntime-node/package.json') return '/fake/ort/package.json';
        throw new Error(`Unexpected: ${id}`);
      });
      return req;
    });

    // ldconfig misses the library
    mockExecFileSync.mockReturnValue('libcublas.so.11 => /usr/lib/libcublas.so.11');

    // CUDA_PATH points to /usr/local/cuda-12
    process.env.CUDA_PATH = '/usr/local/cuda-12';

    // existsSync:
    //   call 1 — .so check for hasOrtCudaProvider → true
    //   call 2 — CUDA_PATH/lib64/libcublasLt.so.12 → true (fallback hit)
    mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(true);

    expect(isCudaAvailable()).toBe(true);
  });
});
