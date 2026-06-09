/**
 * gn_quality_mode — env var preset switch super-function (Phase 3 W3c).
 *
 * A synchronous facade that applies one of three named quality presets by
 * setting / clearing a fixed set of ONTOINDEX_* environment variables on
 * `process.env`.  No external primitives are called — pure configuration.
 *
 * Modes
 * -----
 * fast      : clear ONTOINDEX_INTENT_ENSEMBLE, ONTOINDEX_CITATIONS,
 *             ONTOINDEX_LSP_REFERENCES (all defaults — fastest queries).
 * balanced  : set ONTOINDEX_INTENT_ENSEMBLE=1, ONTOINDEX_CITATIONS=1;
 *             clear ONTOINDEX_LSP_REFERENCES.
 * thorough  : balanced + set ONTOINDEX_LSP_REFERENCES=1,
 *             ONTOINDEX_VEC_POOL_MIN=3.
 *
 * duration
 * --------
 * 'session'      (default) — caller is responsible for reverting if needed.
 * 'until-revert' — identical runtime behaviour; emits an advisory warning
 *                  reminding the caller to revert via gnQualityMode('fast').
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface QualityModeParams {
  level: 'fast' | 'balanced' | 'thorough';
  /** default: 'session' */
  duration?: 'session' | 'until-revert';
}

export interface QualityModeReport {
  version: 1;
  appliedMode: string;
  envVarsSet: Record<string, string>;
  envVarsCleared: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function gnQualityMode(params: QualityModeParams): QualityModeReport {
  const envVarsSet: Record<string, string> = {};
  const envVarsCleared: string[] = [];
  const warnings: string[] = [];

  const setEnv = (key: string, value: string): void => {
    process.env[key] = value;
    envVarsSet[key] = value;
  };

  const clearEnv = (key: string): void => {
    if (key in process.env) {
      delete process.env[key];
      envVarsCleared.push(key);
    }
  };

  if (params.duration === 'until-revert') {
    warnings.push(
      'duration "until-revert" sets process.env directly; revert by calling gn_quality_mode("fast")',
    );
  }

  switch (params.level) {
    case 'fast':
      clearEnv('ONTOINDEX_INTENT_ENSEMBLE');
      clearEnv('ONTOINDEX_CITATIONS');
      clearEnv('ONTOINDEX_LSP_REFERENCES');
      // ONTOINDEX_VEC_POOL_MIN is not a feature flag; fast mode does not touch it.
      break;

    case 'balanced':
      setEnv('ONTOINDEX_INTENT_ENSEMBLE', '1');
      setEnv('ONTOINDEX_CITATIONS', '1');
      clearEnv('ONTOINDEX_LSP_REFERENCES');
      break;

    case 'thorough':
      setEnv('ONTOINDEX_INTENT_ENSEMBLE', '1');
      setEnv('ONTOINDEX_CITATIONS', '1');
      setEnv('ONTOINDEX_LSP_REFERENCES', '1');
      setEnv('ONTOINDEX_VEC_POOL_MIN', '3');
      break;

    default:
      warnings.push(`unknown level "${String(params.level)}" — no changes applied`);
      break;
  }

  return {
    version: 1,
    appliedMode: params.level,
    envVarsSet,
    envVarsCleared,
    warnings,
  };
}
