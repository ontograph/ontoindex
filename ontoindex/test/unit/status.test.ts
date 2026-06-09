import { describe, expect, it, vi } from 'vitest';
import {
  formatIndexCapabilityWarnings,
  formatNativeGraphWriterStatus,
} from '../../src/cli/status.js';
import { appendIndexCapabilityWarnings } from '../../src/storage/index-capabilities.js';
import type { RepoMeta } from '../../src/storage/repo-manager.js';

const nativeModule = () => ({
  writeGraphBatchNative: vi.fn(),
});

describe('status formatting', () => {
  it('formats native graph writer visibility when disabled by default', () => {
    expect(
      formatNativeGraphWriterStatus({
        env: {},
        nativeModule: nativeModule(),
      }),
    ).toBe(
      'Native graph writer: ONTOINDEX_NATIVE_GRAPH_WRITER disabled, not configured, available (ONTOINDEX_NATIVE_GRAPH_WRITER is not set)',
    );
  });

  it('formats native graph writer visibility when enabled but unavailable', () => {
    expect(
      formatNativeGraphWriterStatus({
        env: { ONTOINDEX_NATIVE_GRAPH_WRITER: '1' },
        nativeModule: {},
      }),
    ).toBe(
      'Native graph writer: ONTOINDEX_NATIVE_GRAPH_WRITER enabled, configured, unavailable (native graph writer export is not available)',
    );
  });

  it('keeps legacy full-index metadata quiet', () => {
    const meta: RepoMeta = {
      repoPath: '.',
      lastCommit: 'abc123',
      indexedAt: '2026-05-27T00:00:00.000Z',
    };

    expect(formatIndexCapabilityWarnings(meta)).toEqual([]);
  });

  it('warns explicitly for symbols-only indexes', () => {
    const meta: RepoMeta = {
      repoPath: '.',
      lastCommit: 'abc123',
      indexedAt: '2026-05-27T00:00:00.000Z',
      indexMode: 'symbols-only',
      capabilities: {
        symbols: true,
        impact: 'degraded',
        processes: false,
      },
    };

    expect(formatIndexCapabilityWarnings(meta)).toEqual([
      'WARNING: index capabilities are degraded.',
      'Index mode: symbols-only',
      '  Symbols: available',
      '  Processes: unavailable',
      '  Impact analysis: degraded',
    ]);
  });

  it('surfaces durable degraded metadata when present', () => {
    const meta: RepoMeta = {
      repoPath: '.',
      lastCommit: 'abc123',
      indexedAt: '2026-05-27T00:00:00.000Z',
      pipelineProfile: 'symbols',
      skippedPhases: ['communities', 'processes'],
      degradedFiles: [
        { filePath: 'include/rtl/string.hxx', reason: 'scope extraction skipped' },
        { filePath: 'editeng/source/editeng/editdoc.cxx', reason: 'scope extraction skipped' },
      ],
      partialCheckpointPath: '.ontoindex/analysis-checkpoint.json',
    };

    expect(formatIndexCapabilityWarnings(meta)).toEqual([
      'WARNING: index capabilities are degraded.',
      'Index mode: symbols',
      '  Symbols: available',
      '  Processes: unavailable',
      '  Impact analysis: degraded',
      '  Skipped phases: communities, processes',
      '  Degraded files: 2',
      '  Partial checkpoint: .ontoindex/analysis-checkpoint.json',
    ]);
  });

  it('adds capability warnings to object-shaped tool results', () => {
    expect(
      appendIndexCapabilityWarnings({ status: 'success', warnings: ['pre-existing'] }, [
        'WARNING: index capabilities are degraded.',
      ]),
    ).toEqual({
      status: 'success',
      warnings: ['pre-existing', 'WARNING: index capabilities are degraded.'],
    });
  });
});
