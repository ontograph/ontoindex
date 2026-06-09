/**
 * Phase: scan
 *
 * Walks the repository filesystem and collects file paths + sizes.
 * Does NOT read file contents — that happens in downstream phases.
 *
 * @deps    (none — this is the pipeline root)
 * @reads   repoPath (filesystem)
 * @writes  graph (nothing yet — just returns scanned paths)
 * @output  ScannedFile[], allPaths[], totalFiles
 */

import type { PipelinePhase, PipelineContext } from './types.js';
import { walkRepositoryPaths } from '../filesystem-walker.js';
import v8 from 'node:v8';

export interface ScanOutput {
  scannedFiles: { path: string; size: number }[];
  skippedLargeFiles: { path: string; size: number }[];
  allPaths: string[];
  totalFiles: number;
  dispose?(): void;
}

export const scanPhase: PipelinePhase<ScanOutput> = {
  name: 'scan',
  deps: [],

  async execute(ctx: PipelineContext): Promise<ScanOutput> {
    ctx.onProgress({
      phase: 'extracting',
      percent: 0,
      message: 'Scanning repository...',
    });

    const skippedLargeFiles: { path: string; size: number }[] = [];
    const scannedFiles = await walkRepositoryPaths(
      ctx.repoPath,
      (current, total, filePath) => {
        const scanProgress = Math.round((current / total) * 15);
        ctx.onProgress({
          phase: 'extracting',
          percent: scanProgress,
          message: 'Scanning repository...',
          detail: filePath,
          stats: {
            filesProcessed: current,
            totalFiles: total,
            nodesCreated: ctx.graph.nodeCount,
          },
        });
      },
      {
        onSkippedLargeFile: (file) => skippedLargeFiles.push(file),
        includePaths: ctx.options?.includePaths,
      },
    );

    const totalFiles = scannedFiles.length;
    const allPaths = scannedFiles.map((f) => f.path);
    if (skippedLargeFiles.length > 0 && ctx.options?.onTelemetry) {
      const memory = process.memoryUsage();
      const heap = v8.getHeapStatistics();
      ctx.options.onTelemetry({
        event: 'scan-degraded-files',
        phaseName: 'scan',
        elapsedMs: Date.now() - ctx.pipelineStart,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        heapLimitBytes: heap.heap_size_limit,
        graphNodes: ctx.graph.nodeCount,
        graphRelationships: ctx.graph.relationshipCount,
        chunkFiles: skippedLargeFiles.length,
        chunkBytes: skippedLargeFiles.reduce((sum, file) => sum + file.size, 0),
        degradedReason: 'scan-file-size-cap',
        degradedFiles: skippedLargeFiles.slice(0, 100).map((file) => ({
          filePath: file.path,
          reason: `file exceeds scan file-size cap (${file.size} bytes); set ONTOINDEX_SCAN_MAX_FILE_KB=0 to include`,
        })),
      });
    }

    ctx.onProgress({
      phase: 'extracting',
      percent: 15,
      message: 'Repository scanned successfully',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: ctx.graph.nodeCount },
    });

    return {
      scannedFiles,
      skippedLargeFiles,
      allPaths,
      totalFiles,
      dispose: () => {
        scannedFiles.length = 0;
        skippedLargeFiles.length = 0;
      },
    };
  },
};
