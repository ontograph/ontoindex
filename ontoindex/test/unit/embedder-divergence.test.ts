/**
 * Embedder Divergence Guard
 *
 * Static source-text assertions that verify neither embedder re-introduces
 * inline copies of the CUDA probe functions. These checks encode the v4
 * CUDA bug contract: both embedders must delegate to the shared cuda-probe
 * module — not carry their own definition.
 *
 * This test does NOT spin up a real pipeline, load an ML model, or mock
 * @huggingface/transformers. It only reads source files as text.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// test/unit/ → ontoindex/ → repo root
const repoRoot = resolve(__dirname, '..', '..', '..');
const ontoindexRoot = resolve(repoRoot, 'ontoindex');

const coreEmbedderPath = resolve(ontoindexRoot, 'src', 'core', 'embeddings', 'embedder.ts');
const mcpEmbedderPath = resolve(ontoindexRoot, 'src', 'mcp', 'core', 'embedder.ts');

const coreEmbedderSrc = readFileSync(coreEmbedderPath, 'utf-8');
const mcpEmbedderSrc = readFileSync(mcpEmbedderPath, 'utf-8');

describe('embedder divergence guard', () => {
  it('core embedder does NOT define hasOrtCudaProvider inline', () => {
    expect(coreEmbedderSrc).not.toContain('function hasOrtCudaProvider');
  });

  it('core embedder does NOT define isCudaAvailable inline', () => {
    expect(coreEmbedderSrc).not.toContain('function isCudaAvailable');
  });

  it('core embedder imports isCudaAvailable from the shared cuda-probe module', () => {
    const importsCudaProbe =
      coreEmbedderSrc.includes("from './cuda-probe.js'") ||
      coreEmbedderSrc.includes("from './cuda-probe'");
    expect(importsCudaProbe).toBe(true);
  });

  it('MCP embedder imports isCudaAvailable from the shared cuda-probe module', () => {
    const importsCudaProbe =
      mcpEmbedderSrc.includes("from '../../core/embeddings/cuda-probe.js'") ||
      mcpEmbedderSrc.includes("from '../../core/embeddings/cuda-probe'");
    expect(importsCudaProbe).toBe(true);
  });
});
