/**
 * Unit test: `ontoindex wiki` emits a deprecation warning that points
 * users at `ontoindex audit`.
 *
 * The plan-v3 deprecation contract: legacy wiki CLI is kept for one
 * minor version with a warning, then removed. This test gates the
 * warning's content so a rename or accidental removal is caught.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Make wikiCommand bail out immediately after emitting the warning by
// returning null from getGitRoot. This keeps the test scoped to the
// warning surface — no other wiki behaviour is exercised.
vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: vi.fn().mockReturnValue(null),
  isGitRepo: vi.fn().mockReturnValue(false),
  getCurrentCommit: vi.fn().mockReturnValue(''),
}));

import { wikiCommand } from '../../src/cli/wiki.js';

describe('ontoindex wiki — deprecation warning', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it('emits a deprecation warning that names the audit replacement', async () => {
    await wikiCommand();

    expect(warnSpy).toHaveBeenCalled();
    const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/DEPRECATION/i);
    expect(message).toMatch(/ontoindex wiki/);
    expect(message).toMatch(/ontoindex audit/);
  });

  it('points at MCP resources for architecture exploration', async () => {
    await wikiCommand();

    const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/clusters/);
    expect(message).toMatch(/context/);
  });

  it('emits the warning before any other output', async () => {
    await wikiCommand();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    // The deprecation warning must be the very first thing the user sees —
    // it goes to stderr (console.warn) before any console.log output.
    expect(warnSpy.mock.invocationCallOrder[0]).toBeLessThan(
      logSpy.mock.invocationCallOrder[0] ?? Infinity,
    );
  });
});
