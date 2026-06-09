import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  createPolicyFilter,
  loadRepositoryPolicy,
  matchesPolicyGlob,
  RepositoryPolicyError,
  resolveRepositoryPolicy,
} from '../../src/core/repository-policy.js';

let tmpDirs: string[] = [];

async function tempRepo() {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-policy-'));
  tmpDirs.push(repoPath);
  await fs.mkdir(path.join(repoPath, '.ontoindex'), { recursive: true });
  return repoPath;
}

async function writePolicy(repoPath: string, policy: unknown) {
  await fs.writeFile(path.join(repoPath, '.ontoindex', 'policy.json'), JSON.stringify(policy));
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tmpDirs = [];
});

describe('repository policy', () => {
  it('loads schemaVersion 1 policy fields', async () => {
    const repoPath = await tempRepo();
    await writePolicy(repoPath, {
      schemaVersion: 1,
      ignoreGlobs: ['vendor/**'],
      generatedGlobs: ['src/generated/**'],
      riskThresholds: { deadCode: 'medium' },
      owners: { 'src/**': ['team-core'] },
      audit: { severityThreshold: 'HIGH', blockOnStaleOpen: true },
    });

    await expect(loadRepositoryPolicy(repoPath)).resolves.toMatchObject({
      schemaVersion: 1,
      ignoreGlobs: ['vendor/**'],
      generatedGlobs: ['src/generated/**'],
      riskThresholds: { deadCode: 'medium' },
      owners: { 'src/**': ['team-core'] },
      audit: { severityThreshold: 'HIGH', blockOnStaleOpen: true },
    });
  });

  it('reports actionable schema errors', async () => {
    const repoPath = await tempRepo();
    await writePolicy(repoPath, {
      schemaVersion: 2,
      ignoreGlobs: 'vendor/**',
      owners: { 'src/**': 42 },
      audit: { includeIgnored: 'yes' },
    });

    await expect(loadRepositoryPolicy(repoPath)).rejects.toThrow(RepositoryPolicyError);
    await expect(loadRepositoryPolicy(repoPath)).rejects.toThrow(
      /schemaVersion must be 1; ignoreGlobs must be an array of strings; owners.src\/\*\* must be a string or array of strings; audit.includeIgnored must be a boolean/,
    );
  });

  it('resolves policy with explicit precedence hooks', async () => {
    const repoPath = await tempRepo();
    await writePolicy(repoPath, {
      schemaVersion: 1,
      ignoreGlobs: ['repo-vendor/**'],
      riskThresholds: { audit: 'medium' },
      owners: { 'src/**': 'repo-owner' },
      audit: { severityThreshold: 'MEDIUM' },
    });

    const resolved = await resolveRepositoryPolicy({
      repoPath,
      userDefaults: { riskThresholds: { audit: 'low' }, owners: { 'src/**': 'user-owner' } },
      sessionPolicy: { audit: { severityThreshold: 'HIGH' } },
      toolPolicy: {
        includeIgnored: true,
        ignoreGlobs: ['tool-vendor/**'],
        owners: { 'src/**': 'tool-owner' },
      },
    });

    expect(resolved.includeIgnored).toBe(true);
    expect(resolved.sources).toEqual([
      'built-in defaults',
      'user defaults',
      'repo policy',
      'session policy',
      'tool args',
    ]);
    expect(resolved.policy.ignoreGlobs).toEqual(
      expect.arrayContaining(['repo-vendor/**', 'tool-vendor/**']),
    );
    expect(resolved.policy.riskThresholds.audit).toBe('medium');
    expect(resolved.policy.audit.severityThreshold).toBe('HIGH');
    expect(resolved.policy.owners['src/**']).toEqual(['tool-owner']);
  });

  it('matches and discloses ignored paths without hiding override state', async () => {
    expect(matchesPolicyGlob('src/vendor/lib.ts', 'vendor/**')).toBe(true);

    const filter = createPolicyFilter(
      {
        schemaVersion: 1,
        ignoreGlobs: ['vendor/**'],
        generatedGlobs: ['src/generated/**'],
        riskThresholds: {},
        owners: {},
        audit: {},
      },
      { sources: ['repo policy'] },
    );

    expect(filter.shouldExcludePath('src/vendor/lib.ts')).toBe(true);
    expect(filter.shouldExcludePath('src/app.ts')).toBe(false);
    expect(filter.disclosure).toMatchObject({
      applied: true,
      includeIgnored: false,
      excludedPathCount: 1,
      representativeExcludedPaths: ['src/vendor/lib.ts'],
      sources: ['repo policy'],
    });

    const override = createPolicyFilter(
      {
        schemaVersion: 1,
        ignoreGlobs: ['vendor/**'],
        generatedGlobs: [],
        riskThresholds: {},
        owners: {},
        audit: {},
      },
      { includeIgnored: true },
    );
    expect(override.shouldExcludePath('vendor/lib.ts')).toBe(false);
    expect(override.disclosure.includeIgnored).toBe(true);
  });
});
