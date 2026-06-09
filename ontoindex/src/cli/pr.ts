/**
 * CLI `pr` command group — REV-8.
 *
 * Adds `ontoindex pr impact <number>` as a GitHub-only wrapper over the shared
 * local review builder (`reviewDiffCommand`).
 *
 * Resolution flow:
 *   1. Call `gh pr view <number>` to get baseRefName, headRefName, headSha.
 *   2. Verify both refs resolve locally (no auto-fetch).
 *   3. Delegate to the shared `reviewDiffCommand` with the resolved range.
 *
 * Fails clearly on auth errors or missing local refs; no auto-fetch, no second
 * diff-impact engine.
 *
 * ADR 0020 § Phase 6 — Hosted PR adapter.
 */

import { execFileSync } from 'node:child_process';
import type { Command } from 'commander';
import { reviewDiffCommand } from './review.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GH_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrMetadata {
  baseRefName: string;
  headRefName: string;
  headSha: string;
}

export interface PrImpactOptions {
  repo?: string; // --repo <owner/repo> passed to `gh`
  dir?: string; // local git root (default: cwd)
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Build the `gh pr view` argument list.
 * @param prNumber PR number (string or number)
 * @param ghRepo   Optional `owner/repo` to pass with `--repo` to `gh`
 */
export function buildGhPrViewArgs(prNumber: string | number, ghRepo?: string): string[] {
  const args = ['pr', 'view', String(prNumber), '--json', 'baseRefName,headRefName,headSha'];
  if (ghRepo) {
    args.push('--repo', ghRepo);
  }
  return args;
}

/**
 * Parse the JSON output of `gh pr view --json baseRefName,headRefName,headSha`.
 * Throws with a descriptive message on parse failure or missing fields.
 */
export function parsePrMetadata(raw: string): PrMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`gh pr view returned non-JSON output: ${String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`gh pr view returned unexpected JSON: ${raw.slice(0, 200)}`);
  }
  const obj = parsed as Record<string, unknown>;
  const baseRefName = obj['baseRefName'];
  const headRefName = obj['headRefName'];
  const headSha = obj['headSha'];
  if (typeof baseRefName !== 'string' || !baseRefName) {
    throw new Error('gh pr view: missing or empty baseRefName in response');
  }
  if (typeof headRefName !== 'string' || !headRefName) {
    throw new Error('gh pr view: missing or empty headRefName in response');
  }
  if (typeof headSha !== 'string' || !headSha) {
    throw new Error('gh pr view: missing or empty headSha in response');
  }
  return { baseRefName, headRefName, headSha };
}

/**
 * Build the git diff range string for a PR:
 *   `<baseRefName>..<headSha>`
 *
 * The base is the branch name so it resolves against the local tracking ref.
 * The head is the exact commit SHA so it is repo-portable and does not need
 * a matching local branch.
 */
export function buildPrRange(meta: PrMetadata): string {
  return `${meta.baseRefName}..${meta.headSha}`;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export async function prImpactCommand(prNumber: string, opts: PrImpactOptions): Promise<void> {
  const repoRoot = opts.dir ?? process.cwd();

  // ---- 1. Resolve PR metadata via gh ---------------------------------------
  let ghOutput: string;
  try {
    const ghArgs = buildGhPrViewArgs(prNumber, opts.repo);
    ghOutput = execFileSync('gh', ghArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GH_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // gh exits non-zero on auth failure and prints to stderr; the message
    // surfaced here will contain the gh error text.
    if (/not logged|authentication|token|GITHUB_TOKEN|401|403/i.test(msg)) {
      console.error(`error: gh authentication failed — run \`gh auth login\` first\n  ${msg}`);
    } else if (/Could not resolve to a PullRequest|pull request .* not found/i.test(msg)) {
      console.error(
        `error: PR #${prNumber} not found${opts.repo ? ` in ${opts.repo}` : ''} — check the number and --repo flag`,
      );
    } else {
      console.error(`error: gh pr view failed: ${msg}`);
      console.error('  Ensure `gh` is installed and authenticated: gh auth login');
    }
    process.exitCode = 1;
    return;
  }

  // ---- 2. Parse PR metadata ------------------------------------------------
  let meta: PrMetadata;
  try {
    meta = parsePrMetadata(ghOutput);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  // ---- 3. Verify local refs ------------------------------------------------
  // No auto-fetch. If refs are missing, emit a clear actionable message.
  const refsToCheck: Array<{ ref: string; label: string }> = [
    { ref: meta.baseRefName, label: `base ref (${meta.baseRefName})` },
    { ref: meta.headSha, label: `PR head commit (${meta.headSha.slice(0, 12)})` },
  ];

  for (const { ref, label } of refsToCheck) {
    try {
      execFileSync('git', ['rev-parse', '--verify', ref], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GIT_TIMEOUT_MS,
      });
    } catch {
      console.error(
        `error: ${label} is not available locally.\n` +
          `  Fetch the PR refs first, e.g.:\n` +
          `    git fetch origin ${meta.baseRefName}\n` +
          `    git fetch origin ${meta.headSha}\n` +
          `  Or: gh pr checkout ${prNumber}`,
      );
      process.exitCode = 1;
      return;
    }
  }

  // ---- 4. Delegate to shared local review builder -------------------------
  // This is intentionally the only review code path — no separate graph
  // walker or diff-impact engine is added here.
  await reviewDiffCommand({
    base: meta.baseRefName,
    head: meta.headSha,
    json: opts.json,
    repo: repoRoot,
  });
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPrCommands(program: Command): void {
  const pr = program
    .command('pr')
    .description('GitHub PR commands (requires gh CLI and authentication)');

  pr.command('impact <number>')
    .description(
      'Graph-aware impact report for a GitHub PR.\n' +
        'Resolves PR refs via `gh`, then runs the same local review as `ontoindex review diff`.\n' +
        'Requires: gh installed + authenticated, local repo already fetched.',
    )
    .option(
      '--repo <owner/repo>',
      'GitHub repository (owner/repo). Defaults to the repo inferred by gh from the current directory.',
    )
    .option('--dir <path>', 'Local git root to use (default: current working directory)')
    .option('--json', 'Emit ADR 0018 JSON envelope (machine-readable)')
    .addHelpText(
      'after',
      `
Prerequisites:
  1. gh installed and authenticated:    gh auth login
  2. PR refs available locally:
       git fetch origin <baseBranch>
       gh pr checkout <number>   (fetches head commit)

Examples:
  # Review PR #42 in the current repo:
  ontoindex pr impact 42

  # Specify a GitHub repo explicitly:
  ontoindex pr impact 42 --repo owner/repo

  # JSON output for agents or CI:
  ontoindex pr impact 42 --json

What happens:
  1. Calls \`gh pr view <number> --json baseRefName,headRefName,headSha\`
  2. Verifies both refs exist locally (no auto-fetch, fails clearly if missing)
  3. Runs \`ontoindex review diff --base <baseRef> --head <headSha>\`

Auth errors:
  If gh is not authenticated, the command fails immediately with a clear message.
  Missing local refs also fail immediately with fetch instructions.

Index requirement:
  A OntoIndex index is required for symbol/blast-radius analysis.
  Run \`ontoindex analyze\` first if the index is missing or stale.
`,
    )
    .action((prNumber: string, cmdOpts: PrImpactOptions) => {
      void prImpactCommand(prNumber, cmdOpts);
    });
}
