import { promises as fs } from 'fs';
import path from 'path';
import { minimatch } from 'minimatch';

export interface AuditPolicy {
  includeIgnored?: boolean;
  severityThreshold?: string;
  blockOnStaleOpen?: boolean;
  riskThresholds?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RepositoryPolicy {
  schemaVersion: number;
  ignoreGlobs: string[];
  generatedGlobs: string[];
  riskThresholds: Record<string, unknown>;
  owners: Record<string, string[]>;
  audit: AuditPolicy;
}

export interface PolicyLayer {
  ignoreGlobs?: string[];
  generatedGlobs?: string[];
  riskThresholds?: Record<string, unknown>;
  owners?: Record<string, string | string[]>;
  audit?: AuditPolicy;
  includeIgnored?: boolean;
}

export interface PolicyFilterDisclosure {
  applied: boolean;
  includeIgnored: boolean;
  excludedPathCount: number;
  representativeExcludedPaths: string[];
  globs: string[];
  sources: string[];
}

export class RepositoryPolicyError extends Error {
  readonly errors: string[];

  constructor(
    errors: string[],
    readonly policyPath?: string,
  ) {
    super(`Invalid OntoIndex policy${policyPath ? ` at ${policyPath}` : ''}: ${errors.join('; ')}`);
    this.name = 'RepositoryPolicyError';
    this.errors = errors;
  }
}

export const BUILT_IN_REPOSITORY_POLICY: RepositoryPolicy = {
  schemaVersion: 1,
  ignoreGlobs: [
    'node_modules/**',
    '**/node_modules/**',
    'vendor/**',
    '**/vendor/**',
    'third_party/**',
    '**/third_party/**',
  ],
  generatedGlobs: [
    'generated/**',
    '**/generated/**',
    'dist/**',
    '**/dist/**',
    'build/**',
    '**/build/**',
    '**/*.generated.*',
    '**/*.gen.*',
  ],
  riskThresholds: {},
  owners: {},
  audit: {},
};

const POLICY_RELATIVE_PATH = path.join('.ontoindex', 'policy.json');

export async function loadRepositoryPolicy(repoPath: string): Promise<RepositoryPolicy | null> {
  const policyPath = path.join(repoPath, POLICY_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(policyPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RepositoryPolicyError(
      [`policy.json must be valid JSON: ${(err as Error).message}`],
      policyPath,
    );
  }

  return normalizeRepositoryPolicy(parsed, policyPath);
}

export async function resolveRepositoryPolicy(options: {
  repoPath?: string;
  toolPolicy?: PolicyLayer;
  sessionPolicy?: PolicyLayer;
  userDefaults?: PolicyLayer;
}): Promise<{ policy: RepositoryPolicy; includeIgnored: boolean; sources: string[] }> {
  const repoPolicy = options.repoPath ? await loadRepositoryPolicy(options.repoPath) : null;
  const layers: PolicyLayer[] = [
    BUILT_IN_REPOSITORY_POLICY,
    options.userDefaults ?? {},
    repoPolicy ?? {},
    options.sessionPolicy ?? {},
    options.toolPolicy ?? {},
  ];

  const policy = layers.reduce<RepositoryPolicy>((acc, layer) => mergePolicyLayer(acc, layer), {
    schemaVersion: 1,
    ignoreGlobs: [],
    generatedGlobs: [],
    riskThresholds: {},
    owners: {},
    audit: {},
  });
  policy.schemaVersion = 1;

  const includeIgnored = Boolean(
    options.toolPolicy?.includeIgnored ??
    options.toolPolicy?.audit?.includeIgnored ??
    options.sessionPolicy?.includeIgnored ??
    options.sessionPolicy?.audit?.includeIgnored ??
    repoPolicy?.audit?.includeIgnored ??
    options.userDefaults?.includeIgnored ??
    options.userDefaults?.audit?.includeIgnored ??
    policy.audit.includeIgnored,
  );

  return {
    policy,
    includeIgnored,
    sources: [
      'built-in defaults',
      ...(options.userDefaults ? ['user defaults'] : []),
      ...(repoPolicy ? ['repo policy'] : []),
      ...(options.sessionPolicy ? ['session policy'] : []),
      ...(options.toolPolicy ? ['tool args'] : []),
    ],
  };
}

export function createPolicyFilter(
  policy: RepositoryPolicy,
  options?: { includeIgnored?: boolean; representativeLimit?: number; sources?: string[] },
): {
  shouldExcludePath: (filePath: string) => boolean;
  disclosure: PolicyFilterDisclosure;
} {
  const globs = uniqueStrings([...policy.ignoreGlobs, ...policy.generatedGlobs]);
  const includeIgnored = Boolean(options?.includeIgnored);
  const representativeLimit = options?.representativeLimit ?? 5;
  const representativeExcludedPaths: string[] = [];
  const excludedPaths = new Set<string>();

  return {
    shouldExcludePath(filePath: string): boolean {
      if (includeIgnored || globs.length === 0) return false;
      const normalizedPath = normalizePath(filePath);
      const matched = globs.some((glob) => matchesPolicyGlob(normalizedPath, glob));
      if (!matched) return false;
      excludedPaths.add(normalizedPath);
      if (
        representativeExcludedPaths.length < representativeLimit &&
        !representativeExcludedPaths.includes(normalizedPath)
      ) {
        representativeExcludedPaths.push(normalizedPath);
      }
      return true;
    },
    disclosure: {
      get applied() {
        return !includeIgnored && globs.length > 0;
      },
      includeIgnored,
      get excludedPathCount() {
        return excludedPaths.size;
      },
      representativeExcludedPaths,
      globs,
      sources: options?.sources ?? [],
    } as PolicyFilterDisclosure,
  };
}

export function matchesPolicyGlob(filePath: string, glob: string): boolean {
  const normalizedPath = normalizePath(filePath);
  const normalizedGlob = normalizePath(glob);
  return (
    minimatch(normalizedPath, normalizedGlob, { dot: true }) ||
    minimatch(normalizedPath, `**/${normalizedGlob}`, { dot: true })
  );
}

function normalizeRepositoryPolicy(value: unknown, policyPath?: string): RepositoryPolicy {
  const errors: string[] = [];
  if (!isRecord(value)) {
    throw new RepositoryPolicyError(['policy must be a JSON object'], policyPath);
  }

  if (value.schemaVersion !== 1) {
    errors.push('schemaVersion must be 1');
  }

  const ignoreGlobs = readStringArray(value, 'ignoreGlobs', errors);
  const generatedGlobs = readStringArray(value, 'generatedGlobs', errors);
  const riskThresholds = readObject(value, 'riskThresholds', errors);
  const owners = readOwners(value, errors);
  const audit = readAuditPolicy(value, errors);

  if (errors.length > 0) {
    throw new RepositoryPolicyError(errors, policyPath);
  }

  return {
    schemaVersion: 1,
    ignoreGlobs,
    generatedGlobs,
    riskThresholds,
    owners,
    audit,
  };
}

function readStringArray(record: Record<string, unknown>, key: string, errors: string[]): string[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`${key} must be an array of strings`);
    return [];
  }
  return value;
}

function readObject(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
): Record<string, unknown> {
  const value = record[key];
  if (value === undefined) return {};
  if (!isRecord(value)) {
    errors.push(`${key} must be an object`);
    return {};
  }
  return { ...value };
}

function readOwners(record: Record<string, unknown>, errors: string[]): Record<string, string[]> {
  const value = record.owners;
  if (value === undefined) return {};
  if (!isRecord(value)) {
    errors.push('owners must be an object mapping globs to owner strings or string arrays');
    return {};
  }

  const owners: Record<string, string[]> = {};
  for (const [glob, ownerValue] of Object.entries(value)) {
    if (typeof ownerValue === 'string') {
      owners[glob] = [ownerValue];
      continue;
    }
    if (Array.isArray(ownerValue) && ownerValue.every((item) => typeof item === 'string')) {
      owners[glob] = ownerValue;
      continue;
    }
    errors.push(`owners.${glob} must be a string or array of strings`);
  }
  return owners;
}

function readAuditPolicy(record: Record<string, unknown>, errors: string[]): AuditPolicy {
  const value = record.audit;
  if (value === undefined) return {};
  if (!isRecord(value)) {
    errors.push('audit must be an object');
    return {};
  }
  if (value.includeIgnored !== undefined && typeof value.includeIgnored !== 'boolean') {
    errors.push('audit.includeIgnored must be a boolean');
  }
  if (value.severityThreshold !== undefined && typeof value.severityThreshold !== 'string') {
    errors.push('audit.severityThreshold must be a string');
  }
  if (value.blockOnStaleOpen !== undefined && typeof value.blockOnStaleOpen !== 'boolean') {
    errors.push('audit.blockOnStaleOpen must be a boolean');
  }
  if (value.riskThresholds !== undefined && !isRecord(value.riskThresholds)) {
    errors.push('audit.riskThresholds must be an object');
  }
  return { ...value };
}

function mergePolicyLayer(base: RepositoryPolicy, layer: PolicyLayer): RepositoryPolicy {
  return {
    schemaVersion: 1,
    ignoreGlobs: uniqueStrings([...base.ignoreGlobs, ...(layer.ignoreGlobs ?? [])]),
    generatedGlobs: uniqueStrings([...base.generatedGlobs, ...(layer.generatedGlobs ?? [])]),
    riskThresholds: { ...base.riskThresholds, ...(layer.riskThresholds ?? {}) },
    owners: mergeOwners(base.owners, layer.owners),
    audit: { ...base.audit, ...(layer.audit ?? {}) },
  };
}

function mergeOwners(
  base: Record<string, string[]>,
  layer?: Record<string, string | string[]>,
): Record<string, string[]> {
  if (!layer) return { ...base };
  const merged = { ...base };
  for (const [glob, owners] of Object.entries(layer)) {
    merged[glob] = Array.isArray(owners) ? owners : [owners];
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
}
