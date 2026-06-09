/**
 * Git working tree vs index commit staleness (used by MCP resources, group status, etc.).
 * Lives in core/ so application code does not depend on the MCP package layer.
 */

import { execFileText } from './process/exec-file.js';

interface StalenessInfo {
  isStale: boolean;
  commitsBehind: number;
  hint?: string;
}

/**
 * Check how many commits the index is behind HEAD using the git CLI.
 */
export async function checkStaleness(repoPath: string, lastCommit: string): Promise<StalenessInfo> {
  try {
    const result = (
      await execFileText('git', ['rev-list', '--count', `${lastCommit}..HEAD`], {
        cwd: repoPath,
        timeoutMs: 5_000,
        maxBuffer: 1024 * 1024,
      })
    ).trim();

    const commitsBehind = parseInt(result, 10) || 0;

    if (commitsBehind > 0) {
      return {
        isStale: true,
        commitsBehind,
        hint: `⚠️ Index is ${commitsBehind} commit${commitsBehind > 1 ? 's' : ''} behind HEAD. Run analyze tool to update.`,
      };
    }

    return { isStale: false, commitsBehind: 0 };
  } catch {
    return { isStale: false, commitsBehind: 0 };
  }
}
