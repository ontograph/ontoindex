/**
 * Contract pin: executeParameterized + isWriteQuery / CYPHER_WRITE_RE.
 *
 * executeParameterized is the parameterized entrypoint on the lbug pool
 * (distinct from executeQuery, which applies the read-only write guard).
 * Pins the narrow public surface all MCP backends rely on:
 *
 *   - Not-initialized error shape (message includes repoId and hints initLbug).
 *   - isWriteQuery verb list + case insensitivity + `(?<!:)` lookbehind.
 *   - CALL is allowed (used for FTS / VECTOR read-only procedures).
 */

import { describe, it, expect } from 'vitest';
import {
  executeParameterized,
  isWriteQuery,
  CYPHER_WRITE_RE,
  isLbugReady,
} from '../../src/core/lbug/pool-adapter.js';

describe('executeParameterized — error surface', () => {
  it('rejects when repo is not initialized, mentioning the repoId verbatim', async () => {
    expect(isLbugReady('ghost-repo-contract-pin')).toBe(false);
    await expect(
      executeParameterized('ghost-repo-contract-pin', 'MATCH (n) RETURN n', {}),
    ).rejects.toThrow(/LadybugDB not initialized for repo "ghost-repo-contract-pin"/);
  });

  it('points callers at initLbug in the not-initialized message', async () => {
    await expect(
      executeParameterized('another-ghost-repo', 'MATCH (n) RETURN n', {}),
    ).rejects.toThrow(/initLbug/);
  });
});

describe('CYPHER_WRITE_RE / isWriteQuery — write-verb gating contract', () => {
  it('exports CYPHER_WRITE_RE as a RegExp', () => {
    expect(CYPHER_WRITE_RE).toBeInstanceOf(RegExp);
  });

  it('flags documented write verbs', () => {
    const writeVerbs = [
      'CREATE',
      'DELETE',
      'SET',
      'MERGE',
      'REMOVE',
      'DROP',
      'ALTER',
      'COPY',
      'DETACH',
      'FOREACH',
      'INSTALL',
      'LOAD',
    ];
    for (const verb of writeVerbs) {
      expect(isWriteQuery(`${verb} (n)`), `should flag ${verb}`).toBe(true);
    }
  });

  it('does not flag read-only keywords', () => {
    const readQueries = [
      'MATCH (n) RETURN n',
      'RETURN 1',
      'WITH 1 AS x RETURN x',
      'UNWIND [1,2] AS x RETURN x',
    ];
    for (const q of readQueries) {
      expect(isWriteQuery(q), `should NOT flag "${q}"`).toBe(false);
    }
  });

  it('does not flag CALL — used for read-only FTS / VECTOR procedures', () => {
    expect(isWriteQuery('CALL QUERY_FTS_INDEX($repo, $query)')).toBe(false);
    expect(isWriteQuery('CALL QUERY_VECTOR_INDEX($repo, $vec)')).toBe(false);
  });

  it('is case-insensitive (flag=/i)', () => {
    expect(isWriteQuery('create (n)')).toBe(true);
    expect(isWriteQuery('Create (n)')).toBe(true);
    expect(isWriteQuery('cReAtE (n)')).toBe(true);
  });

  it('does not flag verbs appearing as label/property segments (preceded by ":")', () => {
    // (?<!:) lookbehind — a label named after a write verb must not trigger
    // the guard. Regression-proofing the regex shape.
    expect(isWriteQuery('MATCH (n:CREATE) RETURN n')).toBe(false);
    expect(isWriteQuery('MATCH (n:MERGE) RETURN n')).toBe(false);
    expect(isWriteQuery('MATCH (n:DELETE) RETURN n')).toBe(false);
  });

  it('still flags the verb at statement start even with other tokens present', () => {
    expect(
      isWriteQuery("MATCH (n:Function {id: 'x'}) WITH n CREATE (n)-[:REL]->(m) RETURN m"),
    ).toBe(true);
  });
});
