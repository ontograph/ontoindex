import {
  loadAnalysisCatalog,
  type AnalysisCatalog,
  type AnalysisPackManifest,
  type AnalysisSuiteManifest,
  type AnalysisToolRun,
} from './catalog.js';

interface AnalysisExecutionStep {
  packId: string;
  packName: string;
  tool: string;
  params: Record<string, unknown>;
}

interface AnalysisExecutionPlan {
  rootPath: string;
  target: {
    type: 'pack' | 'suite';
    id: string;
    name: string;
  };
  packs: AnalysisPackManifest[];
  suites: AnalysisSuiteManifest[];
  steps: AnalysisExecutionStep[];
  modelPacks: AnalysisPackManifest[];
  errors: string[];
}

interface ORMClientIdentifierConfig {
  prismaClientIdentifiers: string[];
  supabaseClientIdentifiers: string[];
}

function findPack(catalog: AnalysisCatalog, id: string): AnalysisPackManifest | undefined {
  return catalog.packs.find((pack) => pack.id === id);
}

export async function buildAnalysisExecutionPlan(
  repoPath: string,
  targetId: string,
): Promise<AnalysisExecutionPlan> {
  const catalog = await loadAnalysisCatalog(repoPath);
  const suite = catalog.suites.find((entry) => entry.id === targetId);
  const pack = suite ? undefined : catalog.packs.find((entry) => entry.id === targetId);

  if (!suite && !pack) {
    throw new Error(`No analysis pack or suite with id "${targetId}" found.`);
  }

  const selectedPacks = suite
    ? suite.packs
        .map((id) => findPack(catalog, id))
        .filter((entry): entry is AnalysisPackManifest => Boolean(entry))
    : [pack!];

  const missingPackIds = suite
    ? suite.packs.filter((id) => !selectedPacks.some((entry) => entry.id === id))
    : [];

  const steps: AnalysisExecutionStep[] = selectedPacks.flatMap((entry) =>
    entry.runs.map((run: AnalysisToolRun) => ({
      packId: entry.id,
      packName: entry.name,
      tool: run.tool,
      params: run.params,
    })),
  );

  const modelPacks = selectedPacks.filter((entry) => entry.kind === 'model');
  const errors = [...catalog.errors];
  for (const missing of missingPackIds) {
    errors.push(`suite "${suite!.id}" references missing pack "${missing}"`);
  }

  return {
    rootPath: catalog.rootPath,
    target: suite
      ? { type: 'suite', id: suite.id, name: suite.name }
      : { type: 'pack', id: pack!.id, name: pack!.name },
    packs: selectedPacks,
    suites: suite ? [suite] : [],
    steps,
    modelPacks,
    errors,
  };
}

export async function getActiveModelPacks(
  repoPath: string,
  provides?: string[],
): Promise<AnalysisPackManifest[]> {
  const catalog = await loadAnalysisCatalog(repoPath);
  const required = new Set((provides ?? []).filter((item) => item.length > 0));

  return catalog.packs.filter((pack) => {
    if (pack.kind !== 'model') return false;
    if (required.size === 0) return true;
    return pack.provides.some((item) => required.has(item));
  });
}

export async function getActiveRouteFilePatterns(repoPath: string): Promise<string[]> {
  const packs = await getActiveModelPacks(repoPath, ['route-models']);
  return Array.from(
    new Set(
      packs.flatMap((pack) =>
        pack.routeFilePatterns
          .map((pattern) => pattern.trim())
          .filter((pattern) => pattern.length > 0),
      ),
    ),
  );
}

export async function getActiveComponentFilePatterns(repoPath: string): Promise<string[]> {
  const packs = await getActiveModelPacks(repoPath, ['component-models']);
  return Array.from(
    new Set(
      packs.flatMap((pack) =>
        pack.componentFilePatterns
          .map((pattern) => pattern.trim())
          .filter((pattern) => pattern.length > 0),
      ),
    ),
  );
}

export async function getActiveORMClientIdentifiers(
  repoPath: string,
): Promise<ORMClientIdentifierConfig> {
  const packs = await getActiveModelPacks(repoPath, ['orm-models']);
  return {
    prismaClientIdentifiers: Array.from(
      new Set(
        packs.flatMap((pack) =>
          pack.prismaClientIdentifiers
            .map((identifier) => identifier.trim())
            .filter((identifier) => identifier.length > 0),
        ),
      ),
    ),
    supabaseClientIdentifiers: Array.from(
      new Set(
        packs.flatMap((pack) =>
          pack.supabaseClientIdentifiers
            .map((identifier) => identifier.trim())
            .filter((identifier) => identifier.length > 0),
        ),
      ),
    ),
  };
}
