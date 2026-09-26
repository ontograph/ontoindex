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
  ];

  const readQueries = [
    'MATCH (n:CreateHelpers) RETURN n',
    'MATCH (a)-[:CALLS]->(b) RETURN a, b',
    'MATCH (f:File)-[r:DEFINES]->(n) RETURN n',
    "MATCH (n) WHERE n.name = 'MERGEHelper' RETURN n", // word present as data
    'MATCH (n) RETURN n',
    'MATCH (n) WHERE n.content CONTAINS ":CREATE" RETURN n',
    'MATCH (n:SomethingWithSET) RETURN n',
    // Keywords that appear only inside string literals, identifiers, or comments.
    "MATCH (n) WHERE n.id IN ['File:docs/install.md'] RETURN n",
    "MATCH (n) WHERE n.id = 'Section:x.md:Protocol (local stream-drop only)' RETURN n",
    'MATCH (n) WHERE n.name = "set up the environment" RETURN n',
    "MATCH (n) WHERE n.id = 'it''s a drop-in load helper' RETURN n",
    "MATCH (n) WHERE n.id = 'escaped \\' delete' RETURN n",
    'MATCH (n) RETURN n.`create` AS c',
    'MATCH (n) // delete everything later\nRETURN n',
    'MATCH (n) /* SET n.x = 1 */ RETURN n',
  ];

  const writeQueriesNextToLiterals = [
    "MATCH (n) WHERE n.id = 'File:docs/install.md' DETACH DELETE n",
    "MATCH (n) WHERE n.name = 'x' SET n.name = 'y'",
    "CREATE (n:Node {id: 'read-only'})",
    "MATCH (n) WHERE n.id = 'it''s' DELETE n",
    "MATCH (n) WHERE n.id = 'a\\\\' DELETE n",
  ];

  it('adapter isWriteQuery should detect real write queries', () => {
    for (const q of writeQueries) {
      expect(isWriteQueryAdapter(q), `adapter should detect write for: ${q}`).toBe(true);
    }
  });

  it('adapter isWriteQuery still detects writes next to string literals', () => {
    for (const q of writeQueriesNextToLiterals) {
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
});
