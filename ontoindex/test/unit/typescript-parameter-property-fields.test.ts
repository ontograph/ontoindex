import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { TypeScriptFieldExtractor } from '../../src/core/ingestion/field-extractors/typescript.js';
import type { FieldExtractorContext } from '../../src/core/ingestion/field-types.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import type { TypeEnvironment } from '../../src/core/ingestion/type-env.js';

function extractFields(code: string) {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  const tree = parser.parse(code);
  expect(tree.rootNode.hasError).toBe(false);
  const context: FieldExtractorContext = {
    typeEnv: { fileScope: () => new Map() } as TypeEnvironment,
    symbolTable: createSemanticModel().symbols,
    filePath: 'parameter-properties.ts',
    language: SupportedLanguages.TypeScript,
  };
  return new TypeScriptFieldExtractor().extract(tree.rootNode.namedChild(0)!, context)!.fields;
}

describe('TypeScript constructor parameter property fields', () => {
  it('preserves visibility, readonly, type and source metadata', () => {
    const fields = extractFields(`class User {
      constructor(
        public address: Address,
        private readonly secret: Secret,
        protected service: Service,
        readonly id: string
      ) {}
    }`);

    expect(fields).toEqual([
      {
        name: 'address',
        type: 'Address',
        visibility: 'public',
        isReadonly: false,
        isStatic: false,
        sourceFile: 'parameter-properties.ts',
        line: 3,
      },
      {
        name: 'secret',
        type: 'Secret',
        visibility: 'private',
        isReadonly: true,
        isStatic: false,
        sourceFile: 'parameter-properties.ts',
        line: 4,
      },
      {
        name: 'service',
        type: 'Service',
        visibility: 'protected',
        isReadonly: false,
        isStatic: false,
        sourceFile: 'parameter-properties.ts',
        line: 5,
      },
      {
        name: 'id',
        type: 'string',
        visibility: 'public',
        isReadonly: true,
        isStatic: false,
        sourceFile: 'parameter-properties.ts',
        line: 6,
      },
    ]);
  });

  it('retains optional and default-valued parameter properties', () => {
    const fields = extractFields(`class User {
      constructor(public address: Address = new Address(), readonly nickname?: string) {}
    }`);

    expect(fields.map(({ name, type }) => ({ name, type }))).toEqual([
      { name: 'address', type: 'Address' },
      { name: 'nickname', type: 'string | undefined' },
    ]);
  });

  it('excludes ordinary parameters and nested or nonconstructor parameters', () => {
    const fields = extractFields(`class User {
      constructor(address: Address, optional?: string, count = 0) {
        class Nested { constructor(public nested: Address) {} }
      }
      update(public unrelated: Address, readonly other: string) {}
      static constructor(public fake: Address) {}
      ['constructor'](public computed: Address) {}
    }`);

    expect(fields).toEqual([]);
  });

  it('preserves direct fields alongside parameter properties', () => {
    const fields = extractFields(`class User {
      static readonly version: string = '1';
      constructor(public address: Address) {}
    }`);

    expect(
      fields.map(({ name, type, isStatic, isReadonly }) => ({ name, type, isStatic, isReadonly })),
    ).toEqual([
      { name: 'version', type: 'string', isStatic: true, isReadonly: true },
      { name: 'address', type: 'Address', isStatic: false, isReadonly: false },
    ]);
  });
});
