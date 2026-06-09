import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_GAP_NON_TOOL_ACTION_NAMES,
  recommendEvidenceGapNextSteps,
} from '../../../src/core/recommendations/evidence-gap-next-steps.js';
import { validateOrganicRecommendation } from '../../../src/core/recommendations/organic.js';
import { getCallableToolNames } from '../../../src/mcp/shared/tool-registry.js';

describe('evidence gap next steps', () => {
  it('maps ADR 0028 evidence gaps to public callable tools or explicit non-tool actions', () => {
    const result = recommendEvidenceGapNextSteps([
      'stale_index',
      'tool_contract_drift',
      'docs_only_code_behavior_claim',
      'edit_risk_without_impact_evidence',
      'audit_finding_without_replay_evidence',
      'runtime_diagnostic_support',
      'unknown_evidence_class',
    ]);

    const callableToolNames = new Set(getCallableToolNames({ includeFacades: true }));
    const allowedNonToolActions = new Set<string>(EVIDENCE_GAP_NON_TOOL_ACTION_NAMES);

    expect(result.issues).toEqual([]);
    expect(result.nextTools).toEqual([
      'gn_ensure_fresh',
      'gn_tool_contract',
      'gn_safe_edit_check',
      'gn_audit_replay',
    ]);
    expect(result.nonToolActions).toEqual([
      'fix_registry_drift',
      'verify_graph_or_code_evidence',
      'mark_advisory_degraded',
      'classify_or_downgrade_evidence',
    ]);
    expect(result.nextTools.every((tool) => callableToolNames.has(tool))).toBe(true);
    expect(result.nonToolActions.every((action) => allowedNonToolActions.has(action))).toBe(true);
  });

  it('filters and reports tool steps rejected by the organic recommendation gate', () => {
    const result = recommendEvidenceGapNextSteps(['stale_index', 'tool_contract_drift'], {
      callableToolNames: ['gn_tool_contract'],
    });

    expect(result.nextTools).toEqual(['gn_tool_contract']);
    expect(result.nextSteps.map((step) => step.name)).toEqual([
      'gn_tool_contract',
      'fix_registry_drift',
    ]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          condition: 'stale_index',
          field: 'nextTools[0]',
        }),
      ]),
    );
  });

  it('feeds deterministic next steps into organic validation without admitting invalid tools', () => {
    const callableToolNames = getCallableToolNames({ includeFacades: true });
    const result = recommendEvidenceGapNextSteps(
      ['stale_index', 'tool_contract_drift', 'runtime_diagnostic_support'],
      {
        callableToolNames,
        nonToolActionNames: EVIDENCE_GAP_NON_TOOL_ACTION_NAMES,
      },
    );
    const organicNextSteps = result.nextSteps.map((step) =>
      step.kind === 'tool' ? step.name : { kind: 'non-tool-action' as const, name: step.name },
    );

    expect(result.issues).toEqual([]);
    const valid = validateOrganicRecommendation(
      {
        id: 'rec-evidence-gap-next-steps',
        action: 'resolve-evidence-gaps',
        target: { kind: 'process', name: 'ADR 0028 evidence gaps' },
        reason: 'ADR 0028 evidence gaps are backed by evidence-gap-next-step-map.',
        confidence: 'low',
        evidenceIds: ['evidence-gap-next-step-map'],
        evidenceClasses: ['runtime_diagnostic'],
        nextTools: organicNextSteps,
      },
      {
        callableToolNames,
        nonToolActionNames: EVIDENCE_GAP_NON_TOOL_ACTION_NAMES,
      },
    );
    expect(valid.ok).toBe(true);

    const invalid = validateOrganicRecommendation(
      {
        id: 'rec-evidence-gap-invalid-tool',
        action: 'resolve-evidence-gaps',
        target: { kind: 'process', name: 'ADR 0028 evidence gaps' },
        reason: 'ADR 0028 evidence gaps are backed by evidence-gap-next-step-map.',
        confidence: 'low',
        evidenceIds: ['evidence-gap-next-step-map'],
        evidenceClasses: ['runtime_diagnostic'],
        nextTools: [...organicNextSteps, 'gn_not_registered'],
      },
      {
        callableToolNames,
        nonToolActionNames: EVIDENCE_GAP_NON_TOOL_ACTION_NAMES,
      },
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error('expected invalid tool validation failure');
    expect(invalid.errors).toEqual([
      expect.objectContaining({ field: `nextTools[${organicNextSteps.length}]` }),
    ]);
  });

  it('filters and reports unsupported non-tool actions through the organic gate', () => {
    const result = recommendEvidenceGapNextSteps(['runtime_diagnostic_support'], {
      nonToolActionNames: [],
    });

    expect(result.nextSteps).toEqual([]);
    expect(result.nonToolActions).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        condition: 'runtime_diagnostic_support',
        field: 'nextTools[0]',
      }),
    ]);
  });

  it('dedupes duplicate next steps while preserving stable first-seen order', () => {
    const result = recommendEvidenceGapNextSteps([
      'edit_risk_without_impact_evidence',
      'stale_index',
      'edit_risk_without_impact_evidence',
      'tool_contract_drift',
      'stale_index',
    ]);

    expect(result.nextSteps.map((step) => `${step.kind}:${step.name}`)).toEqual([
      'tool:gn_safe_edit_check',
      'tool:gn_ensure_fresh',
      'tool:gn_tool_contract',
      'non-tool-action:fix_registry_drift',
    ]);
    expect(result.nextTools).toEqual(['gn_safe_edit_check', 'gn_ensure_fresh', 'gn_tool_contract']);
  });

  it('classifies unrecognized conditions as downgrade actions instead of free-form questions', () => {
    const result = recommendEvidenceGapNextSteps(['surprising_new_gap']);

    expect(result.nextTools).toEqual([]);
    expect(result.nonToolActions).toEqual(['classify_or_downgrade_evidence']);
    expect(result.nextSteps).toEqual([
      expect.objectContaining({
        kind: 'non-tool-action',
        name: 'classify_or_downgrade_evidence',
        condition: 'unknown_evidence_class',
      }),
    ]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        field: 'condition',
        value: 'surprising_new_gap',
      }),
    ]);
  });
});
