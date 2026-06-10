import { describe, expect, it } from 'vitest';
import {
  type MentionResolutionCandidate,
  resolveMentions,
} from '../../src/core/workspace/mention-resolution.js';

describe('workspace mention resolution', () => {
  const sharedCandidates: MentionResolutionCandidate[] = [
    { kind: 'symbol', id: 'symbol:auth-service', name: 'AuthService', confidence: 0.9 },
    { kind: 'file', id: 'file:src/auth.ts', path: 'src/auth.ts', confidence: 0.7 },
    { kind: 'process', id: 'proc:login', name: 'login', confidence: 0.85 },
    { kind: 'process', id: 'proc:logout', name: 'logout', confidence: 0.4 },
  ];

  it('resolves exact symbol/file/process mentions against supplied candidates', () => {
    const result = resolveMentions({
      mentions: ['@Symbol:AuthService', '@File:src/auth.ts', '@Process:login'],
      candidates: sharedCandidates,
    });

    expect(result.matches.map((item) => item.status)).toEqual(['resolved', 'resolved', 'resolved']);
    expect(result.matches[0].candidates).toEqual([sharedCandidates[0]]);
    expect(result.matches[1].candidates).toEqual([sharedCandidates[1]]);
    expect(result.matches[2].candidates).toEqual([sharedCandidates[2]]);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('marks ambiguous mentions when top-ranked candidates are equivalent', () => {
    const result = resolveMentions({
      mentions: ['@Symbol:AuthService'],
      candidates: [
        ...sharedCandidates,
        { kind: 'symbol', id: 'symbol:auth-alt', name: 'AuthService', confidence: 0.9 },
        { kind: 'symbol', id: 'symbol:auth-primary', name: 'AuthService', confidence: 0.9 },
      ],
    });

    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    expect(match.status).toBe('ambiguous');
    expect(match.candidates.map((candidate) => candidate.id)).toEqual([
      'symbol:auth-alt',
      'symbol:auth-primary',
      'symbol:auth-service',
    ]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('ambiguous');
  });

  it('reports unresolved mentions when no exact candidate match is found', () => {
    const result = resolveMentions({
      mentions: ['@File:missing.ts'],
      candidates: sharedCandidates,
    });

    expect(result.matches).toEqual([
      {
        mention: '@File:missing.ts',
        status: 'unresolved',
        expectedKind: 'file',
        query: 'missing.ts',
        candidates: [],
      },
    ]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe('unresolved');
  });

  it('reports unsupported mention kinds as diagnostics', () => {
    const result = resolveMentions({
      mentions: ['@Widget:AuthService'],
      candidates: sharedCandidates,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      mention: '@Widget:AuthService',
      status: 'unsupported',
      expectedKind: 'widget',
      query: 'AuthService',
      candidates: [],
    });
    expect(result.diagnostics[0]).toMatchObject({
      code: 'unsupported-kind',
      severity: 'error',
      expectedKind: 'widget',
    });
  });

  it('reports invalid mention syntax as invalid', () => {
    const result = resolveMentions({
      mentions: ['Symbol:AuthService', '@Symbol:'],
      candidates: sharedCandidates,
    });

    expect(result.matches.map((match) => match.status)).toEqual(['invalid', 'invalid']);
    expect(result.diagnostics).toMatchObject([
      { code: 'invalid-mention' },
      { code: 'invalid-mention' },
    ]);
  });

  it('ranks equally matched candidates by stable id for deterministic output', () => {
    const result = resolveMentions({
      mentions: ['@Symbol:AuthService'],
      candidates: [
        { kind: 'symbol', id: 'symbol:zeta', name: 'AuthService', confidence: 0.5 },
        { kind: 'symbol', id: 'symbol:alpha', name: 'AuthService', confidence: 0.5 },
        { kind: 'symbol', id: 'symbol:omega', name: 'AuthService', confidence: 0.5 },
      ],
    });

    expect(result.matches[0].status).toBe('ambiguous');
    expect(result.matches[0].candidates.map((candidate) => candidate.id)).toEqual([
      'symbol:alpha',
      'symbol:omega',
      'symbol:zeta',
    ]);
  });

  it('adds truncation diagnostics for candidate and result limits', () => {
    const result = resolveMentions({
      mentions: ['@Symbol:AuthService', '@Symbol:AuthService', '@Symbol:AuthService'],
      candidates: [
        { kind: 'symbol', id: 'symbol:high', name: 'AuthService', confidence: 0.9 },
        { kind: 'symbol', id: 'symbol:high-alt', name: 'AuthService', confidence: 0.8 },
        { kind: 'symbol', id: 'symbol:low', name: 'AuthService', confidence: 0.7 },
      ],
      maxCandidates: 2,
      maxResults: 2,
    });

    expect(result.matches).toHaveLength(2);
    expect(result.summary.truncatedMentions).toBe(1);
    expect(result.summary.candidateTruncations).toBe(2);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'truncated-candidates',
      'truncated-candidates',
      'truncated-results',
    ]);
  });

  it('does not mutate input mentions or candidate arrays', () => {
    const mentions = ['@Symbol:AuthService', '@Process:login'];
    const candidates: MentionResolutionCandidate[] = [
      { kind: 'symbol', id: 'symbol:auth-service', name: 'AuthService', confidence: 0.9 },
      { kind: 'process', id: 'proc:login', name: 'login', confidence: 0.95 },
    ];
    const mentionsSnapshot = JSON.stringify(mentions);
    const candidatesSnapshot = JSON.stringify(candidates);

    resolveMentions({
      mentions,
      candidates,
      maxCandidates: 1,
      maxResults: 1,
    });

    expect(JSON.stringify(mentions)).toBe(mentionsSnapshot);
    expect(JSON.stringify(candidates)).toBe(candidatesSnapshot);
  });
});
