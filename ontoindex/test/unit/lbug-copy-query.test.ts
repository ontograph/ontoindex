import { describe, expect, it } from 'vitest';
import { getCopyQuery } from '../../src/core/lbug/lbug-adapter.js';

describe('LadybugDB COPY query generation', () => {
  it('loads Const CSVs with the isExported column', () => {
    const query = getCopyQuery('Const', '/tmp/const.csv');

    expect(query).toContain('COPY `Const`');
    expect(query).toContain(
      '(id, name, filePath, startLine, endLine, isExported, content, description)',
    );
  });

  it('keeps non-exported multi-language tables on the seven-column shape', () => {
    const query = getCopyQuery('Struct', '/tmp/struct.csv');

    expect(query).toContain('COPY `Struct`');
    expect(query).toContain('(id, name, filePath, startLine, endLine, content, description)');
    expect(query).not.toContain('isExported');
  });

  it('loads Method CSVs with declaration and definition navigation columns', () => {
    const query = getCopyQuery('Method', '/tmp/method.csv');

    expect(query).toContain('COPY Method');
    expect(query).toContain(
      '(id, name, filePath, startLine, endLine, isExported, content, description, parameterCount, returnType, declarationFilePath, declarationStartLine, declarationEndLine, definitionFilePath, definitionStartLine, definitionEndLine)',
    );
  });

  it('loads Concept CSVs with docs provenance columns', () => {
    const query = getCopyQuery('Concept' as any, '/tmp/concept.csv');

    expect(query).toContain('COPY Concept');
    expect(query).toContain(
      '(id, name, filePath, aliases, sourceDocuments, sourceFactKeys, resolutionKeys, authority, confidence, evidenceClass, freshness)',
    );
  });
});
