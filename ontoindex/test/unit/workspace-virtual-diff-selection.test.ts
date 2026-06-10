import { describe, expect, it } from 'vitest';

import {
  buildVirtualDiffSelectionPlan,
  normalizeVirtualDiff,
  parseVirtualDiff,
  type VirtualDiffSelectionDiagnostic,
  type VirtualDiffInput,
} from '../../src/core/workspace/virtual-diff-selection.js';

const multiFileDiff = [
  'diff --git a/src/alpha.ts b/src/alpha.ts',
  'index aaa..bbb 100644',
  '--- a/src/alpha.ts',
  '+++ b/src/alpha.ts',
  '@@ -10,2 +10,3 @@ alpha',
  '+line1',
  '-old1',
  '+line2',
  '@@ -20 +22 @@ beta',
  '+line3',
  'diff --git a/src/beta.ts b/src/beta.ts',
  'index ccc..ddd 100644',
  '--- a/src/beta.ts',
  '+++ b/src/beta.ts',
  '@@ -1,0 +1,1 @@ gamma',
  '+line4',
].join('\n');

describe('virtual diff parsing', () => {
  it('parses hunks and generates deterministic stable hunk IDs', () => {
    const virtualDiff = parseVirtualDiff(multiFileDiff);
    expect(virtualDiff.files).toHaveLength(2);
    expect(virtualDiff.files[0].path).toBe('src/alpha.ts');
    expect(virtualDiff.files[0].hunks).toHaveLength(2);
    expect(virtualDiff.files[0].hunks[0]).toEqual({
      id: 'src/alpha.ts@@10,2+10,3#0',
      index: 0,
      oldStart: 10,
      oldCount: 2,
      newStart: 10,
      newCount: 3,
    });
    expect(virtualDiff.files[0].hunks[1]).toEqual({
      id: 'src/alpha.ts@@20,1+22,1#1',
      index: 1,
      oldStart: 20,
      oldCount: 1,
      newStart: 22,
      newCount: 1,
    });
    expect(virtualDiff.files[1].hunks[0]).toEqual({
      id: 'src/beta.ts@@1,0+1,1#0',
      index: 0,
      oldStart: 1,
      oldCount: 0,
      newStart: 1,
      newCount: 1,
    });
  });

  it('reproduces the same hunk IDs across runs for deterministic ordering', () => {
    const first = parseVirtualDiff(multiFileDiff).files.flatMap((file) =>
      file.hunks.map((hunk) => hunk.id),
    );
    const second = parseVirtualDiff(multiFileDiff).files.flatMap((file) =>
      file.hunks.map((hunk) => hunk.id),
    );
    expect(second).toEqual(first);
  });

  it('accepts a supplied virtual diff payload and normalizes missing hunk ids', () => {
    const supplied: VirtualDiffInput = {
      files: [
        {
          path: 'src/supplied.ts',
          hunks: [
            { oldStart: 5, oldCount: 1, newStart: 6, newCount: 2 },
            { oldStart: 8, oldCount: 4, newStart: 9, newCount: 3 },
          ],
        },
      ],
    };

    const virtualDiff = normalizeVirtualDiff(supplied);

    expect(virtualDiff.files[0].hunks[0].id).toBe('src/supplied.ts@@5,1+6,2#0');
    expect(virtualDiff.files[0].hunks[1].id).toBe('src/supplied.ts@@8,4+9,3#1');
  });

  it('skips invalid supplied file paths with a structured diagnostic', () => {
    const supplied: VirtualDiffInput = {
      files: [
        {
          path: '/dev/null',
          hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }],
        },
      ],
    };

    const virtualDiff = normalizeVirtualDiff(supplied);

    expect(virtualDiff.files).toEqual([]);
    expect(virtualDiff.diagnostics).toEqual([
      {
        code: 'virtual-diff-invalid-file-path',
        message: 'Skipping virtual diff file with invalid path: /dev/null',
        filePath: '/dev/null',
      },
    ]);
  });
});

describe('virtual diff selection plan', () => {
  it('builds accepted/rejected/deferred summaries without applying hunks', () => {
    const decisions = [
      {
        hunkId: 'src/alpha.ts@@20,1+22,1#1',
        decision: 'reject',
      },
    ];
    const plan = buildVirtualDiffSelectionPlan(multiFileDiff, decisions);
    expect(plan.acceptedHunkCount).toBe(0);
    expect(plan.rejectedHunkCount).toBe(1);
    expect(plan.deferredHunkCount).toBe(2);
    expect(plan.affectedFiles).toBe(2);
  });

  it('links selected hunks to supplied staged context entry IDs and diagnostics', () => {
    const diag: VirtualDiffSelectionDiagnostic = {
      code: 'context-note',
      message: 'linked context note',
      severity: 'warning',
    };

    const plan = buildVirtualDiffSelectionPlan(multiFileDiff, [
      {
        hunkId: 'src/alpha.ts@@10,2+10,3#0',
        decision: 'accept',
        stagedContextEntryIds: ['ctx-2', 'ctx-1', 'ctx-1'],
        diagnostics: [diag],
      },
    ]);

    expect(plan.selections).toHaveLength(3);
    expect(plan.selections[0]).toMatchObject({
      hunkId: 'src/alpha.ts@@10,2+10,3#0',
      status: 'accept',
      decisionProvided: true,
      stagedContextEntryIds: ['ctx-2', 'ctx-1'],
      diagnostics: [{ ...diag, hunkId: 'src/alpha.ts@@10,2+10,3#0' }],
    });
  });

  it('reports unknown hunk decisions as structured diagnostics', () => {
    const plan = buildVirtualDiffSelectionPlan(multiFileDiff, [
      {
        hunkId: 'missing@@1,1+1,1#9',
        decision: 'accept',
      },
    ]);

    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics[0]).toEqual({
      code: 'virtual-diff-unknown-hunk-id',
      message: 'Unknown hunk id: missing@@1,1+1,1#9',
      severity: 'warning',
      hunkId: 'missing@@1,1+1,1#9',
    });
  });

  it('reports duplicate decisions on the same hunk as structured diagnostics', () => {
    const plan = buildVirtualDiffSelectionPlan(multiFileDiff, [
      {
        hunkId: 'src/beta.ts@@1,0+1,1#0',
        decision: 'accept',
      },
      {
        hunkId: 'src/beta.ts@@1,0+1,1#0',
        decision: 'reject',
      },
    ]);

    const betaSelection = plan.selections.find(
      (selection) => selection.hunkId === 'src/beta.ts@@1,0+1,1#0',
    );

    expect(betaSelection).toMatchObject({
      status: 'accept',
      decisionProvided: true,
    });
    expect(plan.diagnostics).toEqual([
      {
        code: 'virtual-diff-duplicate-decision',
        message: 'Duplicate decision for hunk id: src/beta.ts@@1,0+1,1#0',
        severity: 'warning',
        hunkId: 'src/beta.ts@@1,0+1,1#0',
      },
    ]);
  });

  it('preserves deterministic file/hunk ordering regardless of decision order', () => {
    const plan = buildVirtualDiffSelectionPlan(multiFileDiff, [
      {
        hunkId: 'src/beta.ts@@1,0+1,1#0',
        decision: 'accept',
      },
      {
        hunkId: 'src/alpha.ts@@10,2+10,3#0',
        decision: 'reject',
      },
    ]);

    expect(plan.selections.map((selection) => selection.hunkId)).toEqual([
      'src/alpha.ts@@10,2+10,3#0',
      'src/alpha.ts@@20,1+22,1#1',
      'src/beta.ts@@1,0+1,1#0',
    ]);
    expect(plan.selections[0].status).toBe('reject');
    expect(plan.selections[2].status).toBe('accept');
  });

  it('does not mutate input arrays when building the plan', () => {
    const decisions = [
      {
        hunkId: 'src/alpha.ts@@10,2+10,3#0',
        decision: 'accept',
        stagedContextEntryIds: ['ctx-1'],
      },
    ] as const;
    const cloned = decisions.map((decision) => ({
      ...decision,
      stagedContextEntryIds: [...decision.stagedContextEntryIds],
    }));

    const plan = buildVirtualDiffSelectionPlan(multiFileDiff, decisions);
    expect(plan.selections[0].decisionProvided).toBe(true);
    expect(cloned).toEqual(decisions);
  });
});
