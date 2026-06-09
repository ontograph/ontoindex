import { describe, it, expect } from 'vitest';
import {
  TypedQueryDocumentParseError,
  parseTypedQueryDocument,
} from '../../src/core/search/typed-query-document.js';

describe('parseTypedQueryDocument', () => {
  it('parses a valid multi-line typed query document', () => {
    expect(
      parseTypedQueryDocument(`
        intent: release blocker diagnosis

        symbol: loadGraphToLbug
        file: ontoindex/src/core/lbug/lbug-adapter.ts
        lex: relationship split metadata
        vec: why does analyze fail after graph load
        graph: upstream callers
        hyde: explain graph load failure modes
      `),
    ).toEqual({
      intent: 'release blocker diagnosis',
      lines: [
        { type: 'symbol', query: 'loadGraphToLbug', lineNumber: 4 },
        {
          type: 'file',
          query: 'ontoindex/src/core/lbug/lbug-adapter.ts',
          lineNumber: 5,
        },
        { type: 'lex', query: 'relationship split metadata', lineNumber: 6 },
        {
          type: 'vec',
          query: 'why does analyze fail after graph load',
          lineNumber: 7,
        },
        { type: 'graph', query: 'upstream callers', lineNumber: 8 },
        {
          type: 'hyde',
          query: 'explain graph load failure modes',
          lineNumber: 9,
        },
      ],
    });
  });

  it('trims whitespace and preserves searchable line order', () => {
    expect(parseTypedQueryDocument('  vec:  semantic cache  \n symbol:  CacheStore  ')).toEqual({
      lines: [
        { type: 'vec', query: 'semantic cache', lineNumber: 1 },
        { type: 'symbol', query: 'CacheStore', lineNumber: 2 },
      ],
    });
  });

  it('treats untyped plain query lines as lexical query lines', () => {
    expect(parseTypedQueryDocument('\n release blocker diagnosis \n graph load failure ')).toEqual({
      lines: [
        { type: 'lex', query: 'release blocker diagnosis', lineNumber: 2 },
        { type: 'lex', query: 'graph load failure', lineNumber: 3 },
      ],
    });
  });

  it('rejects an unknown typed line type', () => {
    expect(() => parseTypedQueryDocument('route: GET /api/search')).toThrow(
      TypedQueryDocumentParseError,
    );
    expect(() => parseTypedQueryDocument('route: GET /api/search')).toThrow(
      'Unknown typed query line type "route" on line 1',
    );
  });

  it('rejects duplicate intent lines', () => {
    expect(() =>
      parseTypedQueryDocument(`
        intent: release blocker diagnosis
        symbol: loadGraphToLbug
        intent: alternate diagnosis
      `),
    ).toThrow('Duplicate intent line on line 4');
  });

  it('rejects intent without searchable lines', () => {
    expect(() => parseTypedQueryDocument('intent: release blocker diagnosis')).toThrow(
      'Typed query document must include at least one searchable line when intent is provided',
    );
  });

  it('parses valid filter lines', () => {
    expect(
      parseTypedQueryDocument(`
        filter: kind=symbol
        filter: filePath!=node_modules
        filter: capability~semantic
        filter: language=typescript
        filter: repo=ontoindex
        filter: freshness=stale
        symbol: fetch
      `),
    ).toEqual({
      filters: [
        { field: 'kind', operator: '=', value: 'symbol', lineNumber: 2 },
        { field: 'filePath', operator: '!=', value: 'node_modules', lineNumber: 3 },
        { field: 'capability', operator: '~', value: 'semantic', lineNumber: 4 },
        { field: 'language', operator: '=', value: 'typescript', lineNumber: 5 },
        { field: 'repo', operator: '=', value: 'ontoindex', lineNumber: 6 },
        { field: 'freshness', operator: '=', value: 'stale', lineNumber: 7 },
      ],
      lines: [{ type: 'symbol', query: 'fetch', lineNumber: 8 }],
    });
  });

  it('rejects invalid filter formats', () => {
    expect(() => parseTypedQueryDocument('filter: no_operator\nsymbol: fetch')).toThrow(
      'Invalid filter format on line 1',
    );
  });

  it('rejects unsupported filter fields', () => {
    expect(() => parseTypedQueryDocument('filter: unknown=value\nsymbol: fetch')).toThrow(
      'Unsupported filter field "unknown" on line 1',
    );
  });

  it('rejects unsupported filter operators', () => {
    expect(() => parseTypedQueryDocument('filter: kind>symbol\nsymbol: fetch')).toThrow(
      'Invalid filter format on line 1',
    );
  });
});
