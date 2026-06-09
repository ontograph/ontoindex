/**
 * Unit tests for runAuditReport `--annotate` LLM path.
 *
 * Asserts:
 *  - No API key → annotation is undefined (graceful skip, no throw)
 *  - With API key + LLM mock → annotation populated from the LLM response
 *  - Second call with same findings → cache hit (LLM mock called once total)
 *  - force=true bypasses the cache (LLM mock called twice)
 *  - LLM error → annotation is undefined (graceful skip, no throw)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const { llmMocks } = vi.hoisted(() => ({
  llmMocks: {
    resolveLLMConfig: vi.fn(),
    callLLM: vi.fn(),
  },
}));

vi.mock('../../src/core/wiki/llm-client.js', () => llmMocks);

// The fan-out backends are noise for these tests — stub them all to return
// empty/null so runAuditReport finishes fast and only the annotate path is
// under test.
vi.mock('../../src/mcp/local/backend-dead-code.js', () => ({
  runDeadCode: vi.fn().mockResolvedValue({ entries: [] }),
}));
vi.mock('../../src/mcp/local/backend-cycle-detect.js', () => ({
  runCycleDetect: vi.fn().mockResolvedValue({ cycles: [] }),
}));
vi.mock('../../src/mcp/local/backend-coupling-matrix.js', () => ({
  runCouplingMatrix: vi.fn().mockResolvedValue({ rows: [] }),
}));
vi.mock('../../src/mcp/local/backend-tech-debt.js', () => ({
  runTechDebt: vi.fn().mockResolvedValue({ items: [] }),
}));
vi.mock('../../src/mcp/local/backend-hotspot-analysis.js', () => ({
  runHotspotAnalysis: vi.fn().mockResolvedValue({ files: [] }),
}));
vi.mock('../../src/mcp/local/backend-boundary-violations.js', () => ({
  runBoundaryViolations: vi.fn().mockResolvedValue({ violations: [] }),
}));
vi.mock('../../src/mcp/local/backend-verification-gap.js', () => ({
  runVerificationGap: vi.fn().mockResolvedValue({ coverage: [] }),
}));
vi.mock('../../src/mcp/local/backend-graph-diff.js', () => ({
  runGraphDiff: vi.fn().mockResolvedValue({ added: [], removed: [] }),
}));

import { runAuditReport } from '../../src/mcp/local/backend-audit-report.js';

describe('runAuditReport --annotate', () => {
  let tmpStorage: string;
  const repo = {
    id: 'test',
    name: 'test-repo',
    repoPath: '/tmp/test-repo',
    storagePath: '',
    lastCommit: 'abc1234',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpStorage = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-annotate-'));
    repo.storagePath = tmpStorage;
  });

  afterEach(async () => {
    await fs.rm(tmpStorage, { recursive: true, force: true });
  });

  it('skips annotation when no API key is configured', async () => {
    llmMocks.resolveLLMConfig.mockResolvedValue({
      apiKey: '',
      baseUrl: 'http://localhost',
      model: 'test-model',
      maxTokens: 1000,
      temperature: 0,
    });

    const result = await runAuditReport(repo, { annotate: true });

    expect(result.annotation).toBeUndefined();
    expect(llmMocks.callLLM).not.toHaveBeenCalled();
  });

  it('populates annotation from the LLM when API key is set', async () => {
    llmMocks.resolveLLMConfig.mockResolvedValue({
      apiKey: 'sk-test',
      baseUrl: 'http://localhost',
      model: 'test-model',
      maxTokens: 1000,
      temperature: 0,
    });
    llmMocks.callLLM.mockResolvedValue({
      content: '- finding A is actionable\n- finding B is benign',
    });

    const result = await runAuditReport(repo, { annotate: true });

    expect(result.annotation).toBe('- finding A is actionable\n- finding B is benign');
    expect(llmMocks.callLLM).toHaveBeenCalledTimes(1);
  });

  it('cache-hits on the second call when findings hash matches', async () => {
    // generatedAt is stripped from the cache key, so two sequential calls
    // with the same repo+findings produce the same cache key even if the
    // wall-clock timestamp differs between calls. No fake timers needed.
    llmMocks.resolveLLMConfig.mockResolvedValue({
      apiKey: 'sk-test',
      baseUrl: 'http://localhost',
      model: 'test-model',
      maxTokens: 1000,
      temperature: 0,
    });
    llmMocks.callLLM.mockResolvedValue({ content: 'cached annotation' });

    const first = await runAuditReport(repo, { annotate: true });
    const second = await runAuditReport(repo, { annotate: true });

    expect(llmMocks.callLLM).toHaveBeenCalledTimes(1);
    expect(first.annotation).toBe('cached annotation');
    expect(second.annotation).toBe('cached annotation');
  });

  it('force=true bypasses cache and re-issues the LLM call', async () => {
    llmMocks.resolveLLMConfig.mockResolvedValue({
      apiKey: 'sk-test',
      baseUrl: 'http://localhost',
      model: 'test-model',
      maxTokens: 1000,
      temperature: 0,
    });
    llmMocks.callLLM.mockResolvedValueOnce({ content: 'first' });

    await runAuditReport(repo, { annotate: true });

    // Same findings → would normally cache-hit. force=true must cause a
    // fresh LLM dispatch regardless of cache state.
    llmMocks.callLLM.mockResolvedValueOnce({ content: 'second' });
    const second = await runAuditReport(repo, { annotate: true, force: true });

    expect(second.annotation).toBe('second');
    expect(llmMocks.callLLM).toHaveBeenCalledTimes(2);
  });

  it('skips annotation when the LLM call throws', async () => {
    llmMocks.resolveLLMConfig.mockResolvedValue({
      apiKey: 'sk-test',
      baseUrl: 'http://localhost',
      model: 'test-model',
      maxTokens: 1000,
      temperature: 0,
    });
    llmMocks.callLLM.mockRejectedValue(new Error('500 Internal Server Error'));

    const result = await runAuditReport(repo, { annotate: true });

    expect(result.annotation).toBeUndefined();
    expect(llmMocks.callLLM).toHaveBeenCalledTimes(1);
  });

  it('does not call LLM when annotate is false', async () => {
    llmMocks.resolveLLMConfig.mockResolvedValue({
      apiKey: 'sk-test',
      baseUrl: 'http://localhost',
      model: 'test-model',
      maxTokens: 1000,
      temperature: 0,
    });

    const result = await runAuditReport(repo, { annotate: false });

    expect(result.annotation).toBeUndefined();
    expect(llmMocks.callLLM).not.toHaveBeenCalled();
    expect(llmMocks.resolveLLMConfig).not.toHaveBeenCalled();
  });
});
