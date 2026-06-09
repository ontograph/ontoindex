/**
 * CUDA Probe Utilities
 *
 * Shared helpers for detecting whether CUDA acceleration is viable at runtime.
 * Used by both the analyze-time embedder and the MCP query-time embedder so
 * neither blindly attempts CUDA without first confirming the provider is present.
 */

import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { createRequire } from 'module';

/**
 * Check whether the onnxruntime-node package that @huggingface/transformers
 * will actually load at runtime ships the CUDA execution provider.
 *
 * Critical: we resolve from transformers' own module scope, NOT from ours.
 * npm may install two copies — a top-level 1.24.x (our dep) and a nested
 * 1.21.0 (transformers' pinned dep). The guard must inspect whichever copy
 * transformers.js will dlopen, otherwise the check is meaningless.
 */
export function hasOrtCudaProvider(): boolean {
  try {
    const require = createRequire(import.meta.url);
    const transformersDir = dirname(require.resolve('@huggingface/transformers/package.json'));
    const ortRequire = createRequire(join(transformersDir, 'package.json'));
    const ortPath = dirname(ortRequire.resolve('onnxruntime-node/package.json'));
    const arch = process.arch;
    return existsSync(
      join(ortPath, 'bin', 'napi-v6', 'linux', arch, 'libonnxruntime_providers_cuda.so'),
    );
  } catch {
    return false;
  }
}

/**
 * Check whether CUDA libraries are actually available on this system.
 * ONNX Runtime's native layer crashes (uncatchable) if we attempt CUDA
 * without the required shared libraries, so we probe first.
 *
 * Checks both:
 * 1. That system CUDA libraries (libcublasLt) are present
 * 2. That onnxruntime-node ships the CUDA execution provider binary
 *
 * Both conditions must be true — system CUDA libs alone are not enough
 * if onnxruntime-node is a CPU-only build (versions before 1.24.0).
 */
export function isCudaAvailable(): boolean {
  if (!hasOrtCudaProvider()) return false;

  try {
    const out = execFileSync('ldconfig', ['-p'], { timeout: 3000, encoding: 'utf-8' });
    if (out.includes('libcublasLt.so.12')) return true;
  } catch {
    // ldconfig not available (e.g. non-standard container)
  }

  for (const envVar of ['CUDA_PATH', 'LD_LIBRARY_PATH']) {
    const val = process.env[envVar];
    if (!val) continue;
    for (const dir of val.split(':').filter(Boolean)) {
      if (
        existsSync(join(dir, 'lib64', 'libcublasLt.so.12')) ||
        existsSync(join(dir, 'lib', 'libcublasLt.so.12')) ||
        existsSync(join(dir, 'libcublasLt.so.12'))
      )
        return true;
    }
  }

  return false;
}
