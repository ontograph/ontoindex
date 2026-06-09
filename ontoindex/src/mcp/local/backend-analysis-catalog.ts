import {
  loadAnalysisCatalog,
  type AnalysisPackKind,
  type AnalysisTier,
} from '../../analysis-packs/catalog.js';
import { buildAnalysisExecutionPlan } from '../../analysis-packs/execution.js';

interface AnalysisCatalogRepoHandle {
  repoPath: string;
}

interface AnalysisCatalogParams {
  kind?: AnalysisPackKind;
  tier?: AnalysisTier;
  id?: string;
  target?: string;
}

type AnalysisCatalog = Awaited<ReturnType<typeof loadAnalysisCatalog>>;
type AnalysisExecutionPlan = Awaited<ReturnType<typeof buildAnalysisExecutionPlan>>;

interface AnalysisCatalogCounts {
  packs: number;
  suites: number;
  manifestErrors: number;
}

interface AnalysisCatalogTargetPlanResult {
  status: 'success';
  rootPath: string;
  target: AnalysisExecutionPlan['target'];
  packs: AnalysisExecutionPlan['packs'];
  suites: AnalysisExecutionPlan['suites'];
  steps: AnalysisExecutionPlan['steps'];
  modelPacks: AnalysisExecutionPlan['modelPacks'];
  counts: AnalysisCatalogCounts & {
    steps: number;
    modelPacks: number;
  };
  errors: string[];
}

interface AnalysisCatalogListResult {
  status: 'success';
  rootPath: string;
  packs: AnalysisCatalog['packs'];
  suites: AnalysisCatalog['suites'];
  counts: AnalysisCatalogCounts & {
    stablePacks: number;
    experimentalPacks: number;
  };
  errors: string[];
}

type AnalysisCatalogResult = AnalysisCatalogTargetPlanResult | AnalysisCatalogListResult;

export async function runAnalysisCatalog(
  repo: AnalysisCatalogRepoHandle,
  params: AnalysisCatalogParams,
): Promise<AnalysisCatalogResult> {
  if (typeof params.target === 'string' && params.target.trim().length > 0) {
    const plan = await buildAnalysisExecutionPlan(repo.repoPath, params.target.trim());
    return {
      status: 'success',
      rootPath: plan.rootPath,
      target: plan.target,
      packs: plan.packs,
      suites: plan.suites,
      steps: plan.steps,
      modelPacks: plan.modelPacks,
      counts: {
        packs: plan.packs.length,
        suites: plan.suites.length,
        steps: plan.steps.length,
        modelPacks: plan.modelPacks.length,
        manifestErrors: plan.errors.length,
      },
      errors: plan.errors,
    };
  }

  const catalog = await loadAnalysisCatalog(repo.repoPath);
  const idFilter =
    typeof params.id === 'string' && params.id.trim().length > 0 ? params.id.trim() : null;

  const packs = catalog.packs.filter((pack) => {
    if (params.kind && pack.kind !== params.kind) return false;
    if (params.tier && pack.tier !== params.tier) return false;
    if (idFilter && !pack.id.includes(idFilter) && !pack.name.includes(idFilter)) return false;
    return true;
  });

  const packIds = new Set(packs.map((pack) => pack.id));
  const suites = catalog.suites.filter((suite) => {
    if (params.tier && suite.tier !== params.tier) return false;
    if (idFilter && !suite.id.includes(idFilter) && !suite.name.includes(idFilter)) return false;
    if (params.kind && !suite.packs.some((packId) => packIds.has(packId))) return false;
    return true;
  });

  return {
    status: 'success',
    rootPath: catalog.rootPath,
    packs,
    suites,
    counts: {
      packs: packs.length,
      suites: suites.length,
      stablePacks: packs.filter((pack) => pack.tier === 'stable').length,
      experimentalPacks: packs.filter((pack) => pack.tier === 'experimental').length,
      manifestErrors: catalog.errors.length,
    },
    errors: catalog.errors,
  };
}
