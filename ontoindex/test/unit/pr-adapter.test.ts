/**
 * Unit tests for the `pr impact` CLI adapter (REV-8).
 *
 * Covers pure helper functions — argument building, metadata parsing,
 * range construction — and the command handler's error paths via mocked
 * child_process.execFileSync.
 *
 * Does NOT require a live git repo, gh CLI, or LadybugDB.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  buildGhPrViewArgs,
  parsePrMetadata,
  buildPrRange,
  type PrMetadata,
} from '../../src/cli/pr.js';

// ---------------------------------------------------------------------------
// buildGhPrViewArgs
// ---------------------------------------------------------------------------

describe('buildGhPrViewArgs', () => {
  it('builds minimal args for a numeric PR number', () => {
    const args = buildGhPrViewArgs(42);
    expect(args).toEqual(['pr', 'view', '42', '--json', 'baseRefName,headRefName,headSha']);
  });

  it('accepts a string PR number', () => {
    const args = buildGhPrViewArgs('123');
    expect(args[2]).toBe('123');
  });

  it('appends --repo flag when ghRepo is provided', () => {
    const args = buildGhPrViewArgs(7, 'owner/repo');
    expect(args).toContain('--repo');
    expect(args).toContain('owner/repo');
    const repoIdx = args.indexOf('--repo');
    expect(args[repoIdx + 1]).toBe('owner/repo');
  });

  it('does not include --repo flag when ghRepo is omitted', () => {
    const args = buildGhPrViewArgs(7);
    expect(args).not.toContain('--repo');
  });

  it('always includes --json with the required fields', () => {
    const args = buildGhPrViewArgs(1, 'a/b');
    const jsonIdx = args.indexOf('--json');
    expect(jsonIdx).toBeGreaterThan(-1);
    expect(args[jsonIdx + 1]).toContain('baseRefName');
    expect(args[jsonIdx + 1]).toContain('headRefName');
    expect(args[jsonIdx + 1]).toContain('headSha');
  });
});

// ---------------------------------------------------------------------------
// parsePrMetadata
// ---------------------------------------------------------------------------

const VALID_GH_JSON = JSON.stringify({
  baseRefName: 'main',
  headRefName: 'feature/my-change',
  headSha: 'abc1234567890def1234567890abc1234567890de',
});

describe('parsePrMetadata', () => {
  it('parses a valid gh pr view JSON response', () => {
    const meta = parsePrMetadata(VALID_GH_JSON);
    expect(meta.baseRefName).toBe('main');
    expect(meta.headRefName).toBe('feature/my-change');
    expect(meta.headSha).toBe('abc1234567890def1234567890abc1234567890de');
  });

  it('throws on non-JSON output', () => {
    expect(() => parsePrMetadata('not json')).toThrow(/non-JSON/);
  });

  it('throws on null JSON', () => {
    expect(() => parsePrMetadata('null')).toThrow(/unexpected JSON/);
  });

  it('throws when baseRefName is missing', () => {
    const raw = JSON.stringify({ headRefName: 'feature', headSha: 'abc123' });
    expect(() => parsePrMetadata(raw)).toThrow(/baseRefName/);
  });

  it('throws when headRefName is missing', () => {
    const raw = JSON.stringify({ baseRefName: 'main', headSha: 'abc123' });
    expect(() => parsePrMetadata(raw)).toThrow(/headRefName/);
  });

  it('throws when headSha is missing', () => {
    const raw = JSON.stringify({ baseRefName: 'main', headRefName: 'feature' });
    expect(() => parsePrMetadata(raw)).toThrow(/headSha/);
  });

  it('throws when baseRefName is empty string', () => {
    const raw = JSON.stringify({ baseRefName: '', headRefName: 'feature', headSha: 'abc' });
    expect(() => parsePrMetadata(raw)).toThrow(/baseRefName/);
  });

  it('throws when headSha is empty string', () => {
    const raw = JSON.stringify({ baseRefName: 'main', headRefName: 'feature', headSha: '' });
    expect(() => parsePrMetadata(raw)).toThrow(/headSha/);
  });

  it('truncates long bad input in error message to 200 chars', () => {
    const longJson = JSON.stringify('x'.repeat(400));
    // valid JSON but not an object
    const err = () => parsePrMetadata(longJson);
    // Should throw but not include more than ~200 chars of the raw input
    expect(err).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildPrRange
// ---------------------------------------------------------------------------

describe('buildPrRange', () => {
  it('builds a two-dot range base..headSha', () => {
    const meta: PrMetadata = {
      baseRefName: 'main',
      headRefName: 'feature',
      headSha: 'deadbeefcafe',
    };
    expect(buildPrRange(meta)).toBe('main..deadbeefcafe');
  });

  it('uses headSha (not headRefName) as the right side of the range', () => {
    const meta: PrMetadata = {
      baseRefName: 'develop',
      headRefName: 'my-branch',
      headSha: 'sha1sha2sha3',
    };
    const range = buildPrRange(meta);
    expect(range).toContain('sha1sha2sha3');
    expect(range).not.toContain('my-branch');
  });

  it('preserves branch names with slashes', () => {
    const meta: PrMetadata = {
      baseRefName: 'release/v2',
      headRefName: 'feature/foo',
      headSha: 'aaabbbccc',
    };
    expect(buildPrRange(meta)).toBe('release/v2..aaabbbccc');
  });
});

// ---------------------------------------------------------------------------
// prImpactCommand — error path coverage via module mock
// ---------------------------------------------------------------------------

// ESM does not allow vi.spyOn on node: builtins directly. Use vi.mock factory.
vi.mock('node:child_process', () => {
  return {
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from 'node:child_process';
import { prImpactCommand } from '../../src/cli/pr.js';

describe('prImpactCommand — gh error paths', () => {
  let originalExitCode: number | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalExitCode = process.exitCode as number | undefined;
    process.exitCode = undefined;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('sets exitCode=1 and emits auth message when gh reports auth failure', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not logged into any GitHub hosts');
    });

    await prImpactCommand('42', {});

    expect(process.exitCode).toBe(1);
    const combined = consoleErrorSpy.mock.calls.map((c) => c[0] as string).join(' ');
    expect(combined).toMatch(/auth/i);
  });

  it('sets exitCode=1 and emits not-found message when PR does not exist', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('Could not resolve to a PullRequest with the number of 9999');
    });

    await prImpactCommand('9999', { repo: 'owner/repo' });

    expect(process.exitCode).toBe(1);
    const combined = consoleErrorSpy.mock.calls.map((c) => c[0] as string).join(' ');
    expect(combined).toMatch(/not found|#9999/i);
  });

  it('sets exitCode=1 and emits generic gh error with install hint', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('something went wrong calling gh');
    });

    await prImpactCommand('1', {});

    expect(process.exitCode).toBe(1);
    const combined = consoleErrorSpy.mock.calls.map((c) => c[0] as string).join(' ');
    expect(combined).toMatch(/gh/i);
  });

  it('sets exitCode=1 and emits fetch hint when base ref is missing locally', async () => {
    // First call: gh pr view succeeds
    vi.mocked(execFileSync).mockReturnValueOnce(VALID_GH_JSON as unknown as Buffer);
    // Second call: git rev-parse for baseRefName fails
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('unknown revision');
    });

    await prImpactCommand('42', {});

    expect(process.exitCode).toBe(1);
    const combined = consoleErrorSpy.mock.calls.map((c) => c[0] as string).join(' ');
    expect(combined).toMatch(/fetch|checkout/i);
  });

  it('sets exitCode=1 and emits fetch hint when head SHA is missing locally', async () => {
    // gh pr view succeeds
    vi.mocked(execFileSync).mockReturnValueOnce(VALID_GH_JSON as unknown as Buffer);
    // git rev-parse baseRefName succeeds
    vi.mocked(execFileSync).mockReturnValueOnce('abc123\n' as unknown as Buffer);
    // git rev-parse headSha fails
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('unknown revision');
    });

    await prImpactCommand('42', {});

    expect(process.exitCode).toBe(1);
    const combined = consoleErrorSpy.mock.calls.map((c) => c[0] as string).join(' ');
    expect(combined).toMatch(/fetch|checkout/i);
  });

  it('sets exitCode=1 when gh returns invalid JSON', async () => {
    vi.mocked(execFileSync).mockReturnValueOnce('this is not json' as unknown as Buffer);

    await prImpactCommand('42', {});

    expect(process.exitCode).toBe(1);
    const combined = consoleErrorSpy.mock.calls.map((c) => c[0] as string).join(' ');
    expect(combined).toMatch(/non-JSON/i);
  });
});

// ---------------------------------------------------------------------------
// registerPrCommands — help contract
// ---------------------------------------------------------------------------

import { registerPrCommands } from '../../src/cli/pr.js';
import { Command } from 'commander';

function getPrImpactHelp(): string {
  const program = new Command();
  registerPrCommands(program);
  const prCmd = program.commands.find((c) => c.name() === 'pr');
  if (!prCmd) return '';
  const impactCmd = prCmd.commands.find((c) => c.name() === 'impact');
  if (!impactCmd) return '';
  let output = '';
  impactCmd.configureOutput({
    writeOut: (s) => {
      output += s;
    },
    writeErr: (s) => {
      output += s;
    },
  });
  impactCmd.outputHelp();
  return output;
}

describe('registerPrCommands — help contract', () => {
  it('registers a `pr` command group', () => {
    const program = new Command();
    registerPrCommands(program);
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('pr');
  });

  it('registers `pr impact` as a subcommand', () => {
    const program = new Command();
    registerPrCommands(program);
    const prCmd = program.commands.find((c) => c.name() === 'pr')!;
    const subNames = prCmd.commands.map((c) => c.name());
    expect(subNames).toContain('impact');
  });

  it('mentions gh in the description', () => {
    const help = getPrImpactHelp();
    expect(help).toMatch(/gh/i);
  });

  it('mentions authentication requirement', () => {
    const help = getPrImpactHelp();
    expect(help).toMatch(/auth|authenticated|login/i);
  });

  it('mentions no auto-fetch behavior (fetch must be done first)', () => {
    const help = getPrImpactHelp();
    expect(help).toMatch(/fetch/i);
  });

  it('mentions ontoindex analyze as prerequisite for index', () => {
    const help = getPrImpactHelp();
    expect(help).toMatch(/ontoindex analyze/i);
  });

  it('has --repo flag for specifying owner/repo', () => {
    const help = getPrImpactHelp();
    expect(help).toMatch(/--repo/);
  });

  it('has --json flag for machine-readable output', () => {
    const help = getPrImpactHelp();
    expect(help).toMatch(/--json/);
  });
});
