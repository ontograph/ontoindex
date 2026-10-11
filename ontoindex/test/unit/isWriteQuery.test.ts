// ...existing code...
import { describe, it, expect } from 'vitest';
import { isWriteQuery as isWriteQueryAdapter } from '../../src/mcp/core/lbug-adapter';
import { isWriteQuery as isWriteQueryBackend } from '../../src/mcp/local/local-backend';

describe('isWriteQuery regex tests', () => {
  const writeQueries = [
    'CREATE (n:Test {name: "x"})',
    'MATCH (n) SET n.x = 1',
    'MERGE (n:Foo {id: 1})',
    'DELETE n',
    'DROP INDEX ON :Foo(prop)',
    'ALTER TABLE Something',
    'COPY TO something',
    'DETACH DELETE n',
    "MATCH (n) WHERE n.x = 'a' SET n.y = 1",
    'match (n) set n.x = 1',
    '/*x*/CREATE (n)',
    '// SET\nDELETE n',
    'MATCH (n) RETURN "SET", n /* CREATE */ DELETE n',
  ];

  const readQueries = [
    'MATCH (n:CreateHelpers) RETURN n',
    'MATCH (a)-[:CALLS]->(b) RETURN a, b',
    'MATCH (f:File)-[r:DEFINES]->(n) RETURN n',
    "MATCH (n) WHERE n.name = 'MERGEHelper' RETURN n", // word present as data
    'MATCH (n) RETURN n',
    'MATCH (n) WHERE n.content CONTAINS ":CREATE" RETURN n',
    'MATCH (n:SomethingWithSET) RETURN n',
    "MATCH (n) WHERE n.name = 'SET' RETURN n LIMIT 1",
    'MATCH (n) WHERE n.name = "CREATE DELETE" RETURN n',
    String.raw`MATCH (n) WHERE n.name = 'it\'s SET' RETURN n`,
    String.raw`MATCH (n) WHERE n.name = "a\" CREATE" RETURN n`,
    'MATCH (`SET`) RETURN `SET`.`CREATE`',
    'MATCH (`SET``DELETE`) RETURN 1',
    'MATCH (n) // CREATE SET DELETE\nRETURN n',
    'MATCH (n) // CREATE SET DELETE\rRETURN n',
    'MATCH (n) /* SET CREATE DELETE */ RETURN n',
    "MATCH (n) WHERE n.name = '// SET /* DELETE */' RETURN n",
  ];

  it('adapter isWriteQuery should detect real write queries', () => {
    for (const q of writeQueries) {
      expect(isWriteQueryAdapter(q), `adapter should detect write for: ${q}`).toBe(true);
    }
  });

  it('adapter isWriteQuery should not false-positive on label/rel or data', () => {
    for (const q of readQueries) {
      expect(isWriteQueryAdapter(q), `adapter false-positive on: ${q}`).toBe(false);
    }
  });

  it('backend isWriteQuery should detect real write queries', () => {
    for (const q of writeQueries) {
      expect(isWriteQueryBackend(q), `backend should detect write for: ${q}`).toBe(true);
    }
  });

  it('backend isWriteQuery should not false-positive on label/rel or data', () => {
    for (const q of readQueries) {
      expect(isWriteQueryBackend(q), `backend false-positive on: ${q}`).toBe(false);
    }
  });

  it.each([
    "MATCH (n) RETURN 'unterminated",
    'MATCH (n) RETURN "unterminated',
    'MATCH (n) RETURN `unterminated',
    "MATCH (n) RETURN 'trailing\\",
    'MATCH (n) /* unterminated',
  ])('fails closed for an unterminated token: %s', (query) => {
    expect(isWriteQueryAdapter(query)).toBe(true);
    expect(isWriteQueryBackend(query)).toBe(true);
  });
});
