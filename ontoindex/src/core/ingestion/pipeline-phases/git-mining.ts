import path from 'path';
import { type PipelinePhase, type ScanOutput, getPhaseOutput } from './index.js';
import { execFileText } from '../../process/exec-file.js';

/**
 * git-mining phase: extracts temporal coupling (co-change data) from git history.
 *
 * Adds CO_CHANGED_WITH edges between files frequently modified in the same commit.
 */

interface CommitEntry {
  files: string[];
}

const GIT_MINING_PROBE_TIMEOUT_MS = 3_000;
const GIT_MINING_LOG_TIMEOUT_MS = 15_000;
const GIT_MINING_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Parse the raw output of `git log --name-only --pretty=format:"%H"` into an
 * array of commit entries, each carrying the list of changed files.
 * Kept byte-identical to the original inline parsing logic.
 */
function parseGitLog(output: string): CommitEntry[] {
  const blocks = output.split(/\n\s*\n/);
  const result: CommitEntry[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 2) continue;
    const files = lines.slice(1).filter((f) => f.trim() !== '');
    if (files.length > 0) {
      result.push({ files });
    }
  }
  return result;
}

function gitMiningErrorMessage(error: unknown): unknown {
  if (error instanceof Error) {
    return error.message;
  }
  return (error as { message?: string }).message;
}

function gitMiningErrorLogText(error: unknown): string | undefined {
  const message = gitMiningErrorMessage(error);
  return message === undefined ? undefined : String(message);
}

export const gitMiningPhase: PipelinePhase = {
  name: 'gitMining',
  deps: ['scan', 'parse'],
  async execute(ctx, deps) {
    const { repoPath, graph, onProgress } = ctx;
    const scanResult = getPhaseOutput<ScanOutput>(deps, 'scan');

    onProgress({
      phase: 'enriching',
      percent: 0,
      message: 'Mining git history for temporal coupling...',
    });

    try {
      // Check if git is available
      await execFileText('git', ['--version'], {
        timeoutMs: GIT_MINING_PROBE_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      });
    } catch {
      console.warn('[gitMining] Git not found. Skipping git-mining phase.');
      return { status: 'skipped', reason: 'git not found' };
    }

    try {
      // Strip subdir prefix from git-log paths so they match scanResult.allPaths.
      // git log returns repo-root-relative paths; scanResult.allPaths are subdir-relative.
      let subdirPrefix = '';
      try {
        const repoRoot = (
          await execFileText('git', ['rev-parse', '--show-toplevel'], {
            cwd: repoPath,
            timeoutMs: GIT_MINING_PROBE_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
          })
        ).trim();
        const rel = path.relative(repoRoot, path.resolve(repoPath)).replace(/\\/g, '/');
        subdirPrefix = rel ? `${rel}/` : '';
      } catch {
        // Not in a git repo or rev-parse failed — leave subdirPrefix empty
      }

      const CHUNK_SIZE = 200; // commits per chunk
      const TOTAL_COMMIT_LIMIT = 1000; // unchanged from W1a
      const coChangeCounts = new Map<string, number>();
      const scannedPathSet = new Set(scanResult.allPaths);
      const MAX_PAIR_ENTRIES = 500_000; // W1a guard — backstop if streaming still overflows
      const MAX_FILES_PER_COMMIT = 300;
      let pairCountOverflow = false;
      let processedCommits = 0;
      let skippedLargeCommits = 0;

      for (let chunkStart = 0; chunkStart < TOTAL_COMMIT_LIMIT; chunkStart += CHUNK_SIZE) {
        const chunkLimit = Math.min(CHUNK_SIZE, TOTAL_COMMIT_LIMIT - chunkStart);

        let chunkOutput: string;
        try {
          chunkOutput = await execFileText(
            'git',
            [
              'log',
              '--since=12 months ago',
              '--name-only',
              '--pretty=format:%H',
              `--skip=${chunkStart}`,
              '-n',
              String(chunkLimit),
            ],
            {
              cwd: repoPath,
              timeoutMs: GIT_MINING_LOG_TIMEOUT_MS,
              maxBuffer: GIT_MINING_MAX_BUFFER,
            },
          );
        } catch (err) {
          console.warn(
            `[gitMining] chunk skip=${chunkStart} failed: ${gitMiningErrorLogText(err)}`,
          );
          continue;
        }

        const chunkCommits = parseGitLog(chunkOutput);
        if (chunkCommits.length === 0) break; // no more commits in history

        for (let i = 0; i < chunkCommits.length; i++) {
          const { files } = chunkCommits[i];
          // Normalize repo-root-relative paths to subdir-relative paths
          const normalized = subdirPrefix
            ? files.map((f) => (f.startsWith(subdirPrefix) ? f.slice(subdirPrefix.length) : f))
            : files;
          // Only consider files that were actually scanned/indexed
          const validFiles = normalized.filter((f) => scannedPathSet.has(f));
          if (validFiles.length > MAX_FILES_PER_COMMIT) {
            skippedLargeCommits++;
            processedCommits++;
            continue;
          }
          const sortedFiles = validFiles.slice().sort();

          // Create pairs of co-changed files
          for (let a = 0; a < sortedFiles.length; a++) {
            for (let b = a + 1; b < sortedFiles.length; b++) {
              const pair = `${sortedFiles[a]}|${sortedFiles[b]}`;
              coChangeCounts.set(pair, (coChangeCounts.get(pair) || 0) + 1);
              if (coChangeCounts.size > MAX_PAIR_ENTRIES) {
                pairCountOverflow = true;
                console.warn(
                  `[gitMining] coChangeCounts exceeded ${MAX_PAIR_ENTRIES} entries at processed=${processedCommits}/${TOTAL_COMMIT_LIMIT}. Truncating; partial coverage.`,
                );
                break; // breaks inner pair loop
              }
            }
            if (pairCountOverflow) break; // breaks outer file loop
          }

          processedCommits++;

          if (processedCommits % 100 === 0) {
            onProgress({
              phase: 'enriching',
              percent: Math.round((processedCommits / TOTAL_COMMIT_LIMIT) * 100),
              message: `Mining git history: processed ${processedCommits} commits...`,
            });
          }

          if (pairCountOverflow) break; // breaks commit loop for this chunk
        }

        if (pairCountOverflow) break; // W1a guard still works — stop chunking too
      }

      // Add edges for pairs with threshold (e.g., changed together >= 3 times)
      const THRESHOLD = 3;
      let edgesAdded = 0;
      for (const [pair, count] of coChangeCounts.entries()) {
        if (count >= THRESHOLD) {
          const [fileA, fileB] = pair.split('|');

          const idA = `File:${fileA}`;
          const idB = `File:${fileB}`;

          if (graph.getNode(idA) && graph.getNode(idB)) {
            graph.addRelationship({
              id: `git-co-change-${fileA}-${fileB}`,
              sourceId: idA,
              targetId: idB,
              type: 'CO_CHANGED_WITH',
              confidence: Math.min(1.0, count / 10),
              reason: `Co-changed ${count} times in the last 12 months`,
            });
            edgesAdded++;
          }
        }
      }

      console.log(`[gitMining] Added ${edgesAdded} CO_CHANGED_WITH edges.`);
      return {
        status: 'success',
        stats: {
          edgesAdded,
          pairCountOverflow,
          mapSizeAtEnd: coChangeCounts.size,
          skippedLargeCommits,
        },
      };
    } catch (err: unknown) {
      const message = gitMiningErrorMessage(err);
      const logMessage = gitMiningErrorLogText(err);
      if (typeof message === 'string' && message.includes('Map maximum size')) {
        console.error(
          '[gitMining] Map maximum size exceeded — corpus too large for chunked collection.',
        );
      }
      console.error(`[gitMining] Failed: ${logMessage}`);
      return { status: 'failed', reason: message };
    }
  },
};
