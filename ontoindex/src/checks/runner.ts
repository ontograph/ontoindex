import { loadChecks, type CheckDefinition } from './loader.js';
import { evaluateImpactThreshold } from './impact-threshold.js';
import { evaluateSemanticContractCheck } from './semantic-contract.js';
import { LocalBackend } from '../mcp/local/local-backend.js';

interface CheckResult {
  id: string;
  success: boolean;
  message: string;
}

interface NodeError {
  code?: unknown;
}

interface ImpactThresholdArgs {
  target: string;
  max_d1?: number;
  [key: string]: unknown;
}

type ImpactThresholdCheckDefinition = Omit<CheckDefinition, 'type' | 'args'> & {
  type: 'impact-threshold';
  args: ImpactThresholdArgs;
};

type SemanticContractCheckDefinition = Omit<CheckDefinition, 'type'> & {
  type: 'semantic-contract';
};

function isNodeError(err: unknown): err is NodeError {
  return Boolean(err && typeof err === 'object' && 'code' in err);
}

function isImpactThresholdCheck(check: CheckDefinition): check is ImpactThresholdCheckDefinition {
  return check.type === 'impact-threshold';
}

function isSemanticContractCheck(check: CheckDefinition): check is SemanticContractCheckDefinition {
  return check.type === 'semantic-contract';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runChecks(repoPath: string, backend?: LocalBackend): Promise<CheckResult[]> {
  const checksPath = `${repoPath}/.ontoindex/checks.yaml`;

  let checks: CheckDefinition[];
  try {
    checks = await loadChecks(checksPath);
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return [];
    throw err;
  }

  if (checks.length === 0) return [];

  const results: CheckResult[] = [];
  let ownedBackend: LocalBackend | undefined;

  async function getBackend(): Promise<LocalBackend> {
    if (backend) return backend;
    if (!ownedBackend) {
      ownedBackend = new LocalBackend();
      await ownedBackend.init();
    }
    return ownedBackend;
  }

  for (const check of checks) {
    try {
      if (isImpactThresholdCheck(check)) {
        const res = await evaluateImpactThreshold(await getBackend(), check.args);
        results.push({
          id: check.id,
          success: res.pass,
          message: res.message,
        });
      } else if (isSemanticContractCheck(check)) {
        const res = evaluateSemanticContractCheck(check.args);
        results.push({
          id: check.id,
          success: res.pass,
          message: res.message,
        });
      } else {
        results.push({
          id: check.id,
          success: false,
          message: `Unknown check type: ${check.type}`,
        });
      }
    } catch (err: unknown) {
      results.push({
        id: check.id,
        success: false,
        message: `Error running check: ${errorMessage(err)}`,
      });
    }
  }

  return results;
}
