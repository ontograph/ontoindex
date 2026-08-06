import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repoRoot, 'scripts/bench-gate.mjs');
const vitest = path.join(repoRoot, 'node_modules/vitest/vitest.mjs');
const benchmark = path.join(repoRoot, 'test/bench/query.bench.ts');
const checkedBaseline = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'test/bench/baseline.json'), 'utf8'),
);
const tempDirs: string[] = [];

const fixtureBaseline = { numerator: 'production', control: 'control', ratio: 2 };

function runGate(current: unknown, baseline: unknown = fixtureBaseline) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-gate-'));
  tempDirs.push(cwd);
  fs.mkdirSync(path.join(cwd, 'test/bench'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'test/bench/baseline.json'), JSON.stringify(baseline));
  if (current !== undefined) {
    fs.writeFileSync(path.join(cwd, 'test/bench/current.json'), JSON.stringify(current));
  }
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

function vitestResult(productionMean: number, controlMean = 5) {
  return {
    files: [
      {
        filepath: 'test/bench/query.bench.ts',
        groups: [
          {
            fullName: 'Query Benchmarks',
            benchmarks: [
              { name: 'production', mean: productionMean },
              { name: 'control', mean: controlMean },
            ],
          },
        ],
      },
    ],
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('bench-gate', () => {
  it('accepts output produced by a real Vitest benchmark run', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-gate-acceptance-'));
    tempDirs.push(cwd);
    const currentPath = path.join(cwd, 'current.json');
    const benchmarkRun = spawnSync(
      process.execPath,
      [vitest, 'bench', benchmark, '--project=lbug-db', '--outputJson', currentPath],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(benchmarkRun.status, benchmarkRun.stderr).toBe(0);
    const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
    const benchmarks = current.files.flatMap((file: any) =>
      file.groups.flatMap((group: any) => group.benchmarks),
    );
    expect(benchmarks.map((result: any) => result.name).sort()).toEqual(
      [checkedBaseline.control, checkedBaseline.numerator].sort(),
    );
    for (const result of benchmarks) {
      expect(result.mean).toBeGreaterThan(0);
      expect(result.period).toBe(result.mean);
      expect(result.mean * result.hz).toBeCloseTo(1000, 6);
    }
    const numerator = benchmarks.find((result: any) => result.name === checkedBaseline.numerator);
    const control = benchmarks.find((result: any) => result.name === checkedBaseline.control);
    const currentRatio = numerator.mean / control.mean;
    expect(Number.isFinite(currentRatio)).toBe(true);
    expect(checkedBaseline.ratio).toBeGreaterThan(0);

    const gateRoot = path.join(cwd, 'gate');
    fs.mkdirSync(path.join(gateRoot, 'test/bench'), { recursive: true });
    fs.copyFileSync(currentPath, path.join(gateRoot, 'test/bench/current.json'));
    fs.writeFileSync(
      path.join(gateRoot, 'test/bench/baseline.json'),
      JSON.stringify(checkedBaseline),
    );
    const gateRun = spawnSync(process.execPath, [script], { cwd: gateRoot, encoding: 'utf8' });
    expect(gateRun.status, gateRun.stderr).toBe(0);
    expect(gateRun.stdout).toContain(
      `PASS ${checkedBaseline.numerator} / ${checkedBaseline.control}`,
    );
  }, 120_000);

  it('passes unchanged Vitest benchmark output', () => {
    const result = runGate(vitestResult(10));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS production / control');
  });

  it('fails a benchmark regression', () => {
    const result = runGate(vitestResult(12));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('benchmark regression detected');
  });

  it.each([
    ['numerator', { numerator: 'missing', control: 'control', ratio: 2 }],
    ['control', { numerator: 'production', control: 'missing', ratio: 2 }],
  ])('fails when the baseline %s result is missing from current output', (_name, baseline) => {
    const result = runGate(vitestResult(10, 5), baseline);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing current benchmark result "missing"');
  });

  it('fails when current output is missing', () => {
    const result = runGate(undefined);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ENOENT');
  });

  it.each([
    ['empty', { files: [] }],
    ['malformed', { files: [{ groups: [{ benchmarks: [{ name: 'production' }] }] }] }],
    [
      'duplicate',
      {
        files: [
          {
            groups: [
              {
                benchmarks: [
                  { name: 'production', mean: 10 },
                  { name: 'production', mean: 10 },
                  { name: 'control', mean: 5 },
                ],
              },
            ],
          },
        ],
      },
    ],
  ])('fails closed on %s current output', (_name, current) => {
    const result = runGate(current);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error running bench-gate');
  });

  it.each([
    ['missing numerator', { control: 'control', ratio: 2 }],
    ['same benchmark names', { numerator: 'control', control: 'control', ratio: 2 }],
    ['invalid ratio', { numerator: 'production', control: 'control', ratio: 0 }],
  ])('fails closed on %s baseline', (_name, baseline) => {
    const result = runGate(vitestResult(10), baseline);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error running bench-gate');
  });
});
