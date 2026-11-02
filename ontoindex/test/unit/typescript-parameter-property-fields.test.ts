import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { TypeScriptFieldExtractor } from '../../src/core/ingestion/field-extractors/typescript.js';
import type { FieldExtractorContext } from '../../src/core/ingestion/field-types.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import { processParsing } from '../../src/core/ingestion/parsing-processor.js';
import { typescriptProvider } from '../../src/core/ingestion/languages/typescript.js';
import { TYPESCRIPT_QUERIES } from '../../src/core/ingestion/tree-sitter-queries.js';
import { getLabelFromCaptures } from '../../src/core/ingestion/utils/ast-helpers.js';
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
  it('captures required, optional and readonly-only properties without ordinary parameters', () => {
    const parser = new Parser();
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse(`class Store {
      constructor(
        public service: Service,
        private readonly secret: Secret,
        readonly id: string,
        protected fallback: Service = new Service(),
        readonly nickname?: string,
        public optional?: Service,
        ordinary?: Ignored
      ) {}
      update(readonly unrelated: Service) {}
    }`);
    expect(tree.rootNode.hasError).toBe(false);
    const query = new Parser.Query(TypeScript.typescript, TYPESCRIPT_QUERIES);
    const properties = query
      .matches(tree.rootNode)
      .filter(
        (match) =>
          getLabelFromCaptures(
            Object.fromEntries(match.captures.map(({ name, node }) => [name, node])),
            typescriptProvider,
          ) === 'Property',
      );
    expect(
      new Set(
        properties.map(
          (match) => match.captures.find((capture) => capture.name === 'name')!.node.text,
        ),
      ),
    ).toEqual(new Set(['service', 'secret', 'id', 'fallback', 'nickname', 'optional']));
  });

  it.each([
    ['class Store { constructor(public value: Service) {} }', true],
    ['class Store { private constructor(public value: Service) {} }', true],
    ['class Store { protected constructor(public value: Service) {} }', true],
    [
      'class Store { public /* static async get set * */ constructor(readonly value?: Service) {} }',
      true,
    ],
    ['abstract class Store { constructor(public value: Service) {} }', true],
    ['const Store = class { constructor(public value: Service) {} };', true],
    ['const store = { constructor(public value: Service) {} };', false],
    ['class Store { static constructor(public value: Service) {} }', false],
    ['class Store { async constructor(public value: Service) {} }', false],
    ['class Store { get constructor(public value: Service) {} }', false],
    ['class Store { set constructor(public value: Service) {} }', false],
    ['class Store { *constructor(public value: Service) {} }', false],
    ["class Store { ['constructor'](public value: Service) {} }", false],
    ["class Store { 'constructor'(public value: Service) {} }", false],
    ['class Store { update(public value: Service) {} }', false],
  ])('publishes parameter properties only for real constructors: %s', (code, accepted) => {
    const parser = new Parser();
    parser.setLanguage(TypeScript.typescript);
    const tree = parser.parse(code);
    const query = new Parser.Query(TypeScript.typescript, TYPESCRIPT_QUERIES);
    const properties = query
      .matches(tree.rootNode)
      .filter(
        (match) =>
          getLabelFromCaptures(
            Object.fromEntries(match.captures.map(({ name, node }) => [name, node])),
            typescriptProvider,
          ) === 'Property',
      );
    expect(
      properties.map((match) => match.captures.find(({ name }) => name === 'name')!.node.text),
    ).toEqual(accepted ? ['value'] : []);
  });

  it('publishes real constructor properties and direct fields in sequential parsing', async () => {
    const path = 'constructor-publication.ts';
    const graph = createKnowledgeGraph();
    const cache = createASTCache();
    try {
      await processParsing(
        graph,
        [
          {
            path,
            content: `class Store {
        direct: Service;
        public /* static async get set * */ constructor(public value: Service, readonly optional?: Service) {}
        static constructor(public fakeStatic: Service) {}
        async constructor(public fakeAsync: Service) {}
        get constructor(public fakeGet: Service) {}
        set constructor(public fakeSet: Service) {}
        *constructor(public fakeGenerator: Service) {}
        update(public fakeOrdinary: Service) {}
      }
      const store = { constructor(public fakeObject: Service) {} };`,
          },
        ],
        createSemanticModel().symbols,
        cache,
      );
      expect(
        graph.nodes
          .filter(({ label }) => label === 'Property')
          .map(({ properties }) => properties.name)
          .sort(),
      ).toEqual(['direct', 'optional', 'value']);
    } finally {
      cache.clear();
    }
  });

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
