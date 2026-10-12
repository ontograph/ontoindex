import { beforeEach, describe, expect, it, vi } from 'vitest';

const { detectChanges, runImpactKernel, execFileText, resolveCommitRange } = vi.hoisted(() => ({
  detectChanges: vi.fn(),
  runImpactKernel: vi.fn(),
  execFileText: vi.fn(),
  resolveCommitRange: vi.fn(),
}));
vi.mock('../../../src/mcp/local/backend-detect-changes.js', () => ({ detectChanges }));
vi.mock('../../../src/core/process/exec-file.js', () => ({ execFileText }));
vi.mock('../../../src/storage/git.js', () => ({ resolveCommitRange }));
vi.mock('../../../src/core/impact/impact-kernel.js', async () => ({
  ...(await vi.importActual<typeof import('../../../src/core/impact/impact-kernel.js')>(
    '../../../src/core/impact/impact-kernel.js',
  )),
  runImpactKernel,
}));
const { collectVerificationDiff } =
  await import('../../../src/mcp/super/write-through-verification.js');
const repo = { id: 'scope', repoPath: '/repo' };
const selected = { id: 'selected-id', name: 'selected', filePath: 'src/selected.ts' };
const unrelated = { id: 'unrelated-id', name: 'unrelated', filePath: 'src/selected.ts.extra' };

describe('collectVerificationDiff changedFiles scope', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    detectChanges.mockResolvedValue({
      changed_symbols: [selected, unrelated],
      warnings: ['Detector capped.'],
    });
    runImpactKernel.mockResolvedValue({
      impacted: [{ name: 'outsideCaller', filePath: 'other/caller.ts' }],
      warnings: [],
    });
    execFileText.mockResolvedValue('src/selected.ts\nsrc/selected.ts.extra\n');
  });

  it('filters exact file membership before impact and preserves outside callers and detector warnings', async () => {
    const result = await collectVerificationDiff(repo, { changedFiles: ['src/selected.ts'] });
    expect(result.changedSymbols).toEqual(['selected']);
    expect(result.impactedSymbols).toEqual(['outsideCaller']);
    expect(result.warnings).toEqual(['Detector capped.']);
    expect(runImpactKernel).toHaveBeenCalledTimes(1);
    expect(runImpactKernel.mock.calls[0][1]).toMatchObject(selected);
    expect(execFileText).not.toHaveBeenCalled();
  });

  it('skips automatic detection for an empty supplied file list', async () => {
    const result = await collectVerificationDiff(repo, { changedFiles: [] });
    expect(result.symbolRecords).toEqual([]);
    expect(result.impactedSymbols).toEqual([]);
    expect(detectChanges).not.toHaveBeenCalled();
    expect(runImpactKernel).not.toHaveBeenCalled();
  });

  it('preserves ambient detection when changedFiles is omitted', async () => {
    const result = await collectVerificationDiff(repo, {});
    expect(result.changedSymbols).toEqual(['selected', 'unrelated']);
    expect(execFileText).toHaveBeenCalledTimes(1);
    expect(runImpactKernel).toHaveBeenCalledTimes(2);
  });

  it('keeps explicitly supplied symbols authoritative even with an empty file list', async () => {
    const result = await collectVerificationDiff(repo, {
      changedFiles: [],
      changedSymbols: ['manual'],
    });
    expect(result.changedSymbols).toEqual(['manual']);
    expect(detectChanges).not.toHaveBeenCalled();
    expect(runImpactKernel).not.toHaveBeenCalled();
  });

  it.each([
    './src/selected.ts',
    '/repo/src/selected.ts',
    'src/other/../selected.ts',
    'src\\selected.ts',
  ])('normalizes selected in-repo path %s', async (file) => {
    expect((await collectVerificationDiff(repo, { changedFiles: [file] })).changedSymbols).toEqual([
      'selected',
    ]);
  });

  it('normalizes detected paths and excludes outside paths', async () => {
    detectChanges.mockResolvedValue({
      changed_symbols: [
        { ...selected, filePath: '/repo/src/other/../selected.ts' },
        { ...unrelated, filePath: '/elsewhere/src/selected.ts' },
      ],
    });
    expect(
      (
        await collectVerificationDiff(repo, {
          changedFiles: ['src\\selected.ts', '../elsewhere/src/selected.ts'],
        })
      ).changedSymbols,
    ).toEqual(['selected']);
  });

  it('retains symbols missing provenance with a warning', async () => {
    detectChanges.mockResolvedValue({
      changed_symbols: [{ id: 'unknown-id', name: 'unknown' }, unrelated],
    });
    const result = await collectVerificationDiff(repo, { changedFiles: ['src/selected.ts'] });
    expect(result.changedSymbols).toEqual(['unknown']);
    expect(result.warnings).toEqual([expect.stringContaining('no file provenance')]);
  });

  it('preserves impact cap warnings after selection', async () => {
    detectChanges.mockResolvedValue({
      changed_symbols: Array.from({ length: 26 }, (_, i) => ({
        ...selected,
        id: `id-${i}`,
        name: `name-${i}`,
      })),
    });
    const result = await collectVerificationDiff(repo, { changedFiles: ['src/selected.ts'] });
    expect(runImpactKernel).toHaveBeenCalledTimes(25);
    expect(result.warnings).toContain('Impact scan capped at 25 changed symbols.');
  });

  it('validates compare refs even when automatic detection is skipped', async () => {
    resolveCommitRange.mockRejectedValue(new Error('invalid ref'));
    await expect(
      collectVerificationDiff(repo, { changedFiles: [], diffRef: '--unsafe' }),
    ).rejects.toThrow('invalid ref');
    expect(resolveCommitRange).toHaveBeenCalledWith('/repo', '--unsafe');
    expect(detectChanges).not.toHaveBeenCalled();
  });
});
