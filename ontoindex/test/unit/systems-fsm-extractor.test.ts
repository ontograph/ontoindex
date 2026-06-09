import { describe, expect, it } from 'vitest';

import { extractFsm } from '../../src/core/systems-audit/fsm-extractor.js';

describe('FSM extractor MVP', () => {
  it('extracts enum states, guarded transitions, matrix entries, and sidecar provenance', () => {
    const report = extractFsm({
      filePath: 'session.cc',
      enumName: 'SessionState',
      stateVariable: 'state',
      source: `
        enum class SessionState { Init, Ready, Closed };
        void step() {
          if (state == SessionState::Init) {
            state = SessionState::Ready;
          }
          if (state == SessionState::Ready) {
            state = SessionState::Closed;
          }
        }
      `,
    });

    expect(report).toMatchObject({
      version: 1,
      tool: 'gn_extract_fsm',
      status: 'ok',
      primaryGraphFacts: [],
      target: { enumName: 'SessionState', stateVariable: 'state' },
    });
    expect(report.states.map((state) => state.state)).toEqual(['Init', 'Ready', 'Closed']);
    expect(report.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'systems-fsm-transition',
          fromState: 'Init',
          toState: 'Ready',
          reasonCodes: ['assignment', 'conditional-guard'],
          provenance: expect.objectContaining({
            recordKind: 'systems.fsm',
            analyzerId: 'gn_extract_fsm',
            promotedToPrimaryGraph: false,
          }),
        }),
      ]),
    );
    expect(report.transitionMatrix).toEqual({ Init: ['Ready'], Ready: ['Closed'] });
    expect(report.warnings[0]).toContain('bounded static heuristic');
    expect(report.limits.truncated).toBe(false);
  });

  it('warns about missing guards and assignment-only states', () => {
    const report = extractFsm({
      filePath: 'parser.c',
      stateVariable: 'mode',
      maxRecords: 20,
      source: `
        void reset() {
          mode = Failed;
        }
      `,
    });

    expect(report.status).toBe('ok');
    expect(report.states).toEqual([
      expect.objectContaining({ state: 'Failed', source: 'assignment-only', confidence: 0.58 }),
    ]);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          warningKind: 'enum-not-found',
          reasonCodes: ['enum-not-found'],
          whyMayBeFalsePositive: expect.stringContaining('helper functions'),
        }),
        expect.objectContaining({
          warningKind: 'missing-guard',
          state: 'Failed',
          reasonCodes: ['missing-guard'],
        }),
      ]),
    );
    expect(report.skipReasons).toEqual(['enum target was not found in bounded source']);
  });

  it('applies response limits across states, transitions, and warnings', () => {
    const report = extractFsm({
      stateVariable: 'state',
      maxRecords: 3,
      source: `
        enum State { A, B, C, D };
        state = A;
        state = B;
        state = C;
      `,
    });

    expect(report.status).toBe('partial');
    expect(report.limits).toMatchObject({ maxRecords: 3, emitted: 3, truncated: true });
    expect(report.states).toHaveLength(3);
    expect(report.transitions).toHaveLength(0);
  });
});
