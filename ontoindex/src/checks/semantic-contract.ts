import {
  evaluateSemanticContracts,
  summarizeSemanticContractResult,
  type SemanticContractInput,
} from '../core/runtime/semantic-contracts.js';

interface SemanticContractCheckResult {
  pass: boolean;
  message: string;
}

interface BoundedOutputArgs {
  evidence_omitted?: unknown;
  omitted_evidence_count?: unknown;
}

export function evaluateSemanticContractCheck(
  args: Record<string, unknown>,
): SemanticContractCheckResult {
  const input = parseSemanticContractArgs(args);
  const result = evaluateSemanticContracts(input);
  return {
    pass: result.passed,
    message: summarizeSemanticContractResult(result),
  };
}

function parseSemanticContractArgs(args: Record<string, unknown>): SemanticContractInput {
  const diagnostics = args.diagnostics;
  if (!Array.isArray(diagnostics)) {
    throw new Error('semantic-contract check requires args.diagnostics to be an array');
  }

  return {
    diagnostics: diagnostics as SemanticContractInput['diagnostics'],
    graphFreshness: optionalString(args.graph_freshness, 'graph_freshness'),
    userFacing: optionalBoolean(args.user_facing, 'user_facing'),
    boundedOutput: parseBoundedOutput(args.bounded_output),
  };
}

function parseBoundedOutput(value: unknown): SemanticContractInput['boundedOutput'] {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('semantic-contract check args.bounded_output must be an object');
  }

  const boundedOutput = value as BoundedOutputArgs;
  return {
    evidenceOmitted: optionalBoolean(
      boundedOutput.evidence_omitted,
      'bounded_output.evidence_omitted',
    ),
    omittedEvidenceCount: optionalNumber(
      boundedOutput.omitted_evidence_count,
      'bounded_output.omitted_evidence_count',
    ),
  };
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`semantic-contract check args.${name} must be a string`);
  }

  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new Error(`semantic-contract check args.${name} must be a boolean`);
  }

  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`semantic-contract check args.${name} must be a finite number`);
  }

  return value;
}
