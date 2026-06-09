import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'node:module';
import { glob } from 'glob';

const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml') as typeof import('js-yaml');

export const ANALYSIS_PACKS_ROOT = 'ontoindex-packs';

export type AnalysisPackKind = 'library' | 'query' | 'model';
export type AnalysisTier = 'experimental' | 'stable';

export interface AnalysisToolRun {
  tool: string;
  params: Record<string, unknown>;
}

export interface AnalysisPackManifest {
  schema: number;
  id: string;
  name: string;
  version: string;
  kind: AnalysisPackKind;
  tier: AnalysisTier;
  summary: string;
  owners: string[];
  tags: string[];
  provides: string[];
  routeFilePatterns: string[];
  componentFilePatterns: string[];
  prismaClientIdentifiers: string[];
  supabaseClientIdentifiers: string[];
  help?: string;
  runs: AnalysisToolRun[];
  manifestPath: string;
}

export interface AnalysisSuiteManifest {
  schema: number;
  id: string;
  name: string;
  tier: AnalysisTier;
  summary: string;
  packs: string[];
  owners: string[];
  tags: string[];
  manifestPath: string;
}

export interface AnalysisCatalog {
  rootPath: string;
  packs: AnalysisPackManifest[];
  suites: AnalysisSuiteManifest[];
  errors: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('manifest root must be a mapping');
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`missing required "${field}" string`);
  }
  return value.trim();
}

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`"${field}" must be an array of strings`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`"${field}" entry at index ${index} must be a non-empty string`);
    }
    return entry.trim();
  });
}

function asRuns(value: unknown): AnalysisToolRun[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('"runs" must be an array');
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`"runs" entry at index ${index} must be a mapping`);
    }
    const record = entry as Record<string, unknown>;
    const tool = asString(record.tool, `runs[${index}].tool`);
    const params = record.params;
    if (params !== undefined && (!params || typeof params !== 'object' || Array.isArray(params))) {
      throw new Error(`"runs[${index}].params" must be a mapping`);
    }
    return {
      tool,
      params: (params as Record<string, unknown> | undefined) ?? {},
    };
  });
}

function asTier(value: unknown, field: string): AnalysisTier {
  const tier = asString(value, field);
  if (tier !== 'experimental' && tier !== 'stable') {
    throw new Error(`"${field}" must be "experimental" or "stable"`);
  }
  return tier;
}

function asPackKind(value: unknown, field: string): AnalysisPackKind {
  const kind = asString(value, field);
  if (kind !== 'library' && kind !== 'query' && kind !== 'model') {
    throw new Error(`"${field}" must be one of: library, query, model`);
  }
  return kind;
}

async function parseYamlFile(filePath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = yaml.load(raw);
  return asRecord(parsed);
}

function relativeManifestPath(repoPath: string, filePath: string): string {
  return path.relative(repoPath, filePath).split(path.sep).join('/');
}

export function manifestErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    ((typeof error === 'object' && error !== null) || typeof error === 'function') &&
    'message' in error
  ) {
    const message = (error as { message?: unknown }).message;
    return String(message);
  }
  return (error as { message?: string }).message;
}

function toPackManifest(
  parsed: Record<string, unknown>,
  repoPath: string,
  filePath: string,
): AnalysisPackManifest {
  const schema = Number(parsed.schema ?? 1);
  if (!Number.isFinite(schema) || schema < 1) {
    throw new Error('"schema" must be a positive number');
  }

  return {
    schema,
    id: asString(parsed.id, 'id'),
    name: asString(parsed.name, 'name'),
    version: asString(parsed.version, 'version'),
    kind: asPackKind(parsed.kind, 'kind'),
    tier: asTier(parsed.tier, 'tier'),
    summary: asString(parsed.summary, 'summary'),
    owners: asStringArray(parsed.owners, 'owners'),
    tags: asStringArray(parsed.tags, 'tags'),
    provides: asStringArray(parsed.provides, 'provides'),
    routeFilePatterns: asStringArray(parsed.routeFilePatterns, 'routeFilePatterns'),
    componentFilePatterns: asStringArray(parsed.componentFilePatterns, 'componentFilePatterns'),
    prismaClientIdentifiers: asStringArray(
      parsed.prismaClientIdentifiers,
      'prismaClientIdentifiers',
    ),
    supabaseClientIdentifiers: asStringArray(
      parsed.supabaseClientIdentifiers,
      'supabaseClientIdentifiers',
    ),
    help:
      typeof parsed.help === 'string' && parsed.help.trim().length > 0
        ? parsed.help.trim()
        : undefined,
    runs: asRuns(parsed.runs),
    manifestPath: relativeManifestPath(repoPath, filePath),
  };
}

function toSuiteManifest(
  parsed: Record<string, unknown>,
  repoPath: string,
  filePath: string,
): AnalysisSuiteManifest {
  const schema = Number(parsed.schema ?? 1);
  if (!Number.isFinite(schema) || schema < 1) {
    throw new Error('"schema" must be a positive number');
  }

  return {
    schema,
    id: asString(parsed.id, 'id'),
    name: asString(parsed.name, 'name'),
    tier: asTier(parsed.tier, 'tier'),
    summary: asString(parsed.summary, 'summary'),
    packs: asStringArray(parsed.packs, 'packs'),
    owners: asStringArray(parsed.owners, 'owners'),
    tags: asStringArray(parsed.tags, 'tags'),
    manifestPath: relativeManifestPath(repoPath, filePath),
  };
}

export async function loadAnalysisCatalog(repoPath: string): Promise<AnalysisCatalog> {
  const rootPath = path.join(repoPath, ANALYSIS_PACKS_ROOT);
  const errors: string[] = [];

  try {
    await fs.access(rootPath);
  } catch {
    return { rootPath, packs: [], suites: [], errors };
  }

  const [packPaths, suitePaths] = await Promise.all([
    glob(`${ANALYSIS_PACKS_ROOT}/**/pack.yml`, {
      cwd: repoPath,
      absolute: true,
      nodir: true,
    }),
    glob(`${ANALYSIS_PACKS_ROOT}/**/suite.yml`, {
      cwd: repoPath,
      absolute: true,
      nodir: true,
    }),
  ]);

  const packs: AnalysisPackManifest[] = [];
  for (const filePath of packPaths) {
    try {
      const parsed = await parseYamlFile(filePath);
      packs.push(toPackManifest(parsed, repoPath, filePath));
    } catch (error: unknown) {
      errors.push(`${relativeManifestPath(repoPath, filePath)}: ${manifestErrorMessage(error)}`);
    }
  }

  const suites: AnalysisSuiteManifest[] = [];
  for (const filePath of suitePaths) {
    try {
      const parsed = await parseYamlFile(filePath);
      suites.push(toSuiteManifest(parsed, repoPath, filePath));
    } catch (error: unknown) {
      errors.push(`${relativeManifestPath(repoPath, filePath)}: ${manifestErrorMessage(error)}`);
    }
  }

  packs.sort((a, b) => a.id.localeCompare(b.id));
  suites.sort((a, b) => a.id.localeCompare(b.id));
  errors.sort((a, b) => a.localeCompare(b));

  return { rootPath, packs, suites, errors };
}
