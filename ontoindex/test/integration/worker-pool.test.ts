/**
 * Integration Tests: Worker Pool & Parse Worker
 *
 * Verifies that the worker pool can spawn real worker threads using the
 * compiled dist/ parse-worker.js and process files correctly.
 * This is critical for cross-platform CI where vitest runs from src/
 * but workers need compiled .js files.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createWorkerPool,
  WorkerPool,
  WORKER_SUB_BATCH_TIMEOUT_MS,
} from '../../src/core/ingestion/workers/worker-pool.js';

import { createEmptyResult } from '../../src/core/ingestion/workers/parse-types.js';
import type {
  ParseWorkerInput,
  ParseWorkerResult,
} from '../../src/core/ingestion/workers/parse-types.js';
import { SupportedLanguages, type GraphNode } from 'ontoindex-shared';

import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import {
  processImports,
  processImportsFromExtracted,
} from '../../src/core/ingestion/import-processor.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';

import { processCallsFromExtracted } from '../../src/core/ingestion/call-processor.js';

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const DIST_WORKER = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'core',
  'ingestion',
  'workers',
  'parse-worker.js',
);
const hasDistWorker = fs.existsSync(DIST_WORKER);

describe('worker pool integration', () => {
  let pool: WorkerPool | undefined;

  afterEach(async () => {
    if (pool) {
      await pool.terminate();
      pool = undefined;
    }
  });

  it('preserves declared field metadata through compiled worker IPC', async () => {
    expect(fs.existsSync(DIST_WORKER)).toBe(true);
    pool = createWorkerPool(pathToFileURL(DIST_WORKER), 1, { cooperativeShutdown: true });
    const inputs = [
      {
        path: 'fields.ts',
        content: `class Store {
          untyped;
          constructor(public service: Service, ordinary: Ignored) {}
        }
        class OtherStore { constructor(public service: OtherService) {} }`,
      },
      { path: 'fields.go', content: 'package example\ntype Store struct { Service *Service }' },
      {
        path: 'fields.php',
        content: `<?php class Store {
          public $untyped;
          public function __construct(public Service $service, Ignored $ordinary) {}
        }`,
      },
      {
        path: 'fields.rb',
        content:
          'class Store\n  # @return [Service]\n  attr_accessor :service\n  attr_accessor :untyped\nend',
      },
    ];
    const results = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>(inputs);
    expect(results.reduce((count, result) => count + result.fileCount, 0)).toBe(inputs.length);
    const properties = results
      .flatMap((result) => result.symbols)
      .filter((symbol) => symbol.type === 'Property');
    const expected = [
      { name: 'service', ownerId: 'Class:fields.ts:Store', declaredType: 'Service' },
      { name: 'service', ownerId: 'Class:fields.ts:OtherStore', declaredType: 'OtherService' },
      { name: 'untyped', ownerId: 'Class:fields.ts:Store', declaredType: undefined },
      { name: 'Service', ownerId: 'Struct:fields.go:Store', declaredType: 'Service' },
      { name: 'service', ownerId: 'Class:fields.php:Store', declaredType: 'Service' },
      { name: 'untyped', ownerId: 'Class:fields.php:Store', declaredType: undefined },
      { name: 'service', ownerId: 'Class:fields.rb:Store', declaredType: 'Service' },
      { name: 'untyped', ownerId: 'Class:fields.rb:Store', declaredType: undefined },
    ];
    expect(properties).toHaveLength(expected.length);
    expect(
      properties.map(({ name, ownerId, declaredType }) => ({ name, ownerId, declaredType })),
    ).toEqual(expect.arrayContaining(expected));
    expect(
      properties
        .filter(
          ({ ownerId, name }) => ownerId?.startsWith('Class:fields.ts:') && name === 'service',
        )
        .map(({ nodeId }) => nodeId),
    ).toEqual(
      expect.arrayContaining([
        'Property:fields.ts:Store.service',
        'Property:fields.ts:OtherStore.service',
      ]),
    );
    for (const property of properties.filter(({ name }) => name === 'untyped')) {
      expect(property).not.toHaveProperty('declaredType');
    }
  });

  it('publishes constructor properties through compiled worker IPC', async () => {
    expect(fs.existsSync(DIST_WORKER)).toBe(true);
    pool = createWorkerPool(pathToFileURL(DIST_WORKER), 1, { cooperativeShutdown: true });
    const results = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>([
      {
        path: 'constructor.ts',
        content: `class Service {} class Store {
          constructor(public required: Service, readonly only: Service,
            public optional?: Service, ordinary?: Service) {}
        }`,
      },
    ]);
    const properties = results
      .flatMap((result) => result.symbols)
      .filter((symbol) => symbol.type === 'Property');
    expect(properties.map(({ name }) => name).sort()).toEqual(['only', 'optional', 'required']);
    for (const property of properties) {
      expect(property).toMatchObject({
        ownerId: 'Class:constructor.ts:Store',
        nodeId: `Property:constructor.ts:Store.${property.name}`,
        declaredType: property.name === 'optional' ? 'Service | undefined' : 'Service',
      });
    }
    expect(
      results
        .flatMap((result) => result.nodes)
        .filter((node) => node.label === 'Property')
        .map((node) => node.properties.name)
        .sort(),
    ).toEqual(['only', 'optional', 'required']);
  });

  it('excludes invalid constructor properties through compiled worker IPC', async () => {
    expect(fs.existsSync(DIST_WORKER)).toBe(true);
    pool = createWorkerPool(pathToFileURL(DIST_WORKER), 1, { cooperativeShutdown: true });
    const results = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>([
      {
        path: 'invalid-constructor.ts',
        content: `const object = { constructor(public objectOnly: string) {} };
          class Store {
            direct: string;
            constructor(public valid: string) {}
            static constructor(public staticOnly: string) {}
            async constructor(public asyncOnly: string) {}
          }`,
      },
    ]);
    expect(
      results
        .flatMap((result) => result.symbols)
        .filter((symbol) => symbol.type === 'Property')
        .map((symbol) => symbol.name)
        .sort(),
    ).toEqual(['direct', 'valid']);
    expect(
      results
        .flatMap((result) => result.nodes)
        .filter((node) => node.label === 'Property')
        .map((node) => node.properties.name)
        .sort(),
    ).toEqual(['direct', 'valid']);
  });

  it('preserves unknown and typed parenthesized receivers through compiled worker IPC', async () => {
    expect(fs.existsSync(DIST_WORKER)).toBe(true);
    pool = createWorkerPool(pathToFileURL(DIST_WORKER), 1, { cooperativeShutdown: true });
    const inputs = [
      'value',
      '(value)',
      '((value))',
      '(value.a.b.c.d)',
      `${'('.repeat(33)}value${')'.repeat(33)}`,
      '(value as Unknown)',
      'value!',
    ].map((receiver, i) => ({
      path: `unknown-${i}.ts`,
      content: `class Unrelated { save() {} } function use<T>(value: T) { ${receiver}.save(); }`,
    }));
    inputs.push({
      path: 'typed.ts',
      content: 'class Known { save() {} } function typed(value: Known) { (value).save(); }',
    });
    const results = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>(inputs);
    const calls = results.flatMap((result) => result.calls);
    const symbols = results.flatMap((result) => result.symbols);
    for (const input of inputs) {
      expect(
        calls.filter((call) => call.filePath === input.path && call.calledName === 'save'),
      ).toHaveLength(1);
    }
    const context = createResolutionContext();
    const graph = createKnowledgeGraph();
    try {
      for (const symbol of symbols) {
        context.model.symbols.add(symbol.filePath, symbol.name, symbol.nodeId, symbol.type, {
          ownerId: symbol.ownerId,
        });
      }
      await processCallsFromExtracted(graph, calls, context);
      const target = symbols.find(
        (symbol) => symbol.filePath === 'typed.ts' && symbol.name === 'save',
      );
      const caller = symbols.find(
        (symbol) => symbol.filePath === 'typed.ts' && symbol.name === 'typed',
      );
      expect(target).toBeDefined();
      expect(caller).toBeDefined();
      expect(
        graph.relationships
          .filter((edge) => edge.type === 'CALLS')
          .map(({ sourceId, targetId }) => ({ sourceId, targetId })),
      ).toEqual([{ sourceId: caller!.nodeId, targetId: target!.nodeId }]);
    } finally {
      context.clear();
    }
  });

  it.each(['thread', 'process'] as const)(
    'preserves Go indexed receivers through compiled worker IPC (%s)',
    async (isolation) => {
      expect(fs.existsSync(DIST_WORKER)).toBe(true);
      pool = createWorkerPool(pathToFileURL(DIST_WORKER), 1, {
        isolation,
        cooperativeShutdown: true,
      });
      const results = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>([
        {
          path: 'indexed.go',
          content: `package main
type User struct {}
func (u User) Save() {}
func (u User) Greet() {}
type Other struct {}
func (o Other) Save() {}
func caller() {
  sl := make([]User, 1)
  m := make(map[string]User)
  sl[0].Save()
  m["key"].Greet()
}
func unknownCaller() { unknown[0].Save() }
`,
        },
      ]);
      const calls = results
        .flatMap((result) => result.calls)
        .filter((call) => ['Save', 'Greet'].includes(call.calledName));
      expect(calls).toEqual([
        expect.objectContaining({
          calledName: 'Save',
          callForm: 'member',
          receiverName: 'sl[0]',
          receiverTypeName: 'User',
        }),
        expect.objectContaining({
          calledName: 'Greet',
          callForm: 'member',
          receiverName: 'm["key"]',
          receiverTypeName: 'User',
        }),
        expect.objectContaining({
          calledName: 'Save',
          callForm: 'member',
          receiverName: 'unknown[0]',
        }),
      ]);
      expect(calls[2]!.receiverTypeName).toBeUndefined();
      const symbols = results.flatMap((result) => result.symbols);
      const context = createResolutionContext();
      const graph = createKnowledgeGraph();
      try {
        for (const symbol of symbols) {
          context.model.symbols.add(symbol.filePath, symbol.name, symbol.nodeId, symbol.type, {
            ownerId: symbol.ownerId,
          });
        }
        await processCallsFromExtracted(graph, calls, context);
        expect(
          graph.relationships
            .filter((edge) => edge.type === 'CALLS')
            .map(({ sourceId, targetId }) => ({ sourceId, targetId }))
            .sort((left, right) => left.targetId.localeCompare(right.targetId)),
        ).toEqual([
          {
            sourceId: 'Function:indexed.go:caller',
            targetId: 'Method:indexed.go:User.Greet#0',
          },
          {
            sourceId: 'Function:indexed.go:caller',
            targetId: 'Method:indexed.go:User.Save#0',
          },
        ]);
      } finally {
        context.clear();
      }
    },
  );

  it.each(['thread', 'process'] as const)(
    'preserves Go generic indexed receiver abstention through compiled worker IPC (%s)',
    async (isolation) => {
      expect(fs.existsSync(DIST_WORKER)).toBe(true);
      pool = createWorkerPool(pathToFileURL(DIST_WORKER), 1, {
        isolation,
        cooperativeShutdown: true,
      });
      const fixtures = [
        {
          path: 'external-constraint.go',
          declaration: 'func caller[T remote.Saver](items []T) { items[0].Save() }',
          receiverTypeName: undefined,
        },
        {
          path: 'shadowed-type.go',
          declaration: 'func caller[User interface{ Save() }](items []User) { items[0].Save() }',
          receiverTypeName: undefined,
        },
        {
          path: 'concrete-type.go',
          declaration: 'func caller(items []User) { items[0].Save() }',
          receiverTypeName: 'User',
        },
        {
          path: 'generic-concrete-type.go',
          declaration: 'func caller[T any](items []User) { items[0].Save() }',
          receiverTypeName: 'User',
        },
        {
          path: 'parenthesized-shadowed-receiver.go',
          declaration: 'func (box (Box[User])) caller(items []User) { items[0].Save() }',
          receiverTypeName: undefined,
        },
        {
          path: 'pointer-parenthesized-shadowed-receiver.go',
          declaration: 'func (box *(Box[User])) caller(items []User) { items[0].Save() }',
          receiverTypeName: undefined,
        },
        {
          path: 'nested-shadowed-receiver.go',
          declaration: 'func (box (*((Box[User])))) caller(items []User) { items[0].Save() }',
          receiverTypeName: undefined,
        },
        {
          path: 'wrapped-concrete-receiver.go',
          declaration: 'func (box *(Box[T])) caller(items []User) { items[0].Save() }',
          receiverTypeName: 'User',
        },
      ];
      const results = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>(
        fixtures.map(({ path, declaration }) => ({
          path,
          content: `package main
import remote "example.com/remote"
type User struct {}
type Box[T any] struct {}
func (u User) Save() {}
${declaration}
`,
        })),
      );
      for (const fixture of fixtures) {
        const calls = results
          .flatMap((result) => result.calls)
          .filter((call) => call.filePath === fixture.path && call.calledName === 'Save');
        expect(calls).toEqual([
          expect.objectContaining({
            calledName: 'Save',
            callForm: 'member',
            receiverName: 'items[0]',
          }),
        ]);
        expect(calls[0]!.receiverTypeName).toBe(fixture.receiverTypeName);
        const symbols = results
          .flatMap((result) => result.symbols)
          .filter((symbol) => symbol.filePath === fixture.path);
        const context = createResolutionContext();
        const graph = createKnowledgeGraph();
        try {
          for (const symbol of symbols) {
            context.model.symbols.add(symbol.filePath, symbol.name, symbol.nodeId, symbol.type, {
              ownerId: symbol.ownerId,
            });
          }
          const targets = symbols.filter((symbol) => symbol.name === 'Save');
          expect(targets).toHaveLength(1);
          expect(targets[0]!.nodeId).toBe(`Method:${fixture.path}:User.Save#0`);
          const callers = symbols.filter((symbol) => symbol.name === 'caller');
          expect(callers).toHaveLength(1);
          if (fixture.declaration.startsWith('func (box ')) {
            expect(callers[0]!.type).toBe('Method');
            expect(callers[0]!.nodeId.startsWith(`Method:${fixture.path}:`)).toBe(true);
          } else {
            expect(callers[0]!.nodeId).toBe(`Function:${fixture.path}:caller`);
          }
          await processCallsFromExtracted(graph, calls, context);
          expect(
            graph.relationships
              .filter((edge) => edge.type === 'CALLS')
              .map(({ sourceId, targetId }) => ({ sourceId, targetId })),
          ).toEqual(
            fixture.receiverTypeName === undefined
              ? []
              : [
                  {
                    sourceId: callers[0]!.nodeId,
                    targetId: `Method:${fixture.path}:User.Save#0`,
                  },
                ],
          );
        } finally {
          context.clear();
        }
      }
    },
  );

  it.skipIf(!isLanguageAvailable(SupportedLanguages.Swift)).each(['thread', 'process'] as const)(
    'preserves Swift self receivers through compiled worker IPC (%s)',
    async (isolation) => {
      expect(fs.existsSync(DIST_WORKER)).toBe(true);
      pool = createWorkerPool(pathToFileURL(DIST_WORKER), 1, {
        isolation,
        cooperativeShutdown: true,
      });
      const results = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>([
        {
          path: 'self.swift',
          content: `class Service {
  func save() {}
  func caller() { self.save() }
}
class Other { func save() {} }`,
        },
      ]);
      const calls = results
        .flatMap((result) => result.calls)
        .filter((call) => call.calledName === 'save');
      expect(calls).toEqual([
        expect.objectContaining({
          calledName: 'save',
          callForm: 'member',
          receiverName: 'self',
          receiverTypeName: 'Service',
        }),
      ]);
      const symbols = results.flatMap((result) => result.symbols);
      const context = createResolutionContext();
      const graph = createKnowledgeGraph();
      try {
        for (const node of results.flatMap((result) => result.nodes)) {
          graph.addNode(node as GraphNode);
        }
        for (const symbol of symbols) {
          context.model.symbols.add(symbol.filePath, symbol.name, symbol.nodeId, symbol.type, {
            ownerId: symbol.ownerId,
          });
        }
        await processCallsFromExtracted(graph, calls, context);
        const owner = symbols.find((symbol) => symbol.name === 'Service');
        expect(owner).toBeDefined();
        const target = symbols.find(
          (symbol) => symbol.name === 'save' && symbol.ownerId === owner!.nodeId,
        );
        const caller = symbols.find(
          (symbol) => symbol.name === 'caller' && symbol.ownerId === owner!.nodeId,
        );
        expect(target).toBeDefined();
        expect(caller).toBeDefined();
        expect(
          graph.relationships
            .filter((edge) => edge.type === 'CALLS')
            .map(({ sourceId, targetId }) => ({ sourceId, targetId })),
        ).toEqual([{ sourceId: caller!.nodeId, targetId: target!.nodeId }]);
        for (const edge of graph.relationships.filter((edge) => edge.type === 'CALLS')) {
          expect(graph.getNode(edge.sourceId)).toBeDefined();
          expect(graph.getNode(edge.targetId)).toBeDefined();
        }
      } finally {
        context.clear();
      }
    },
  );

  it('keeps exported declaration ownership in the compiled worker', async () => {
    expect(fs.existsSync(DIST_WORKER)).toBe(true);
    pool = createWorkerPool(pathToFileURL(DIST_WORKER), 1, { cooperativeShutdown: true });
    const content = [
      'export function publicFunction() { function nestedFunction() {} const nestedArrow = () => 1; }',
      'function privateFunction() {}',
      'export const publicArrow = () => { function arrowLocal() {} };',
      'export class PublicClass { member() { function methodLocal() {} } }',
      'export const object = { objectMember() {} };',
    ].join('\n');
    const results = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>(
      ['ts', 'js'].map((extension) => ({
        path: `exports.${extension}`,
        content:
          extension === 'ts'
            ? [
                'export declare function publicAmbient(): void;',
                'declare function privateAmbient(): void;',
                'export declare class PublicAmbientClass {}',
                'declare class PrivateAmbientClass {}',
                content,
              ].join('\n')
            : content,
      })),
    );
    for (const extension of ['ts', 'js']) {
      const nodes = results
        .flatMap((result) => result.nodes)
        .filter((node) => node.properties.filePath === `exports.${extension}`);
      for (const [name, exported] of [
        ['publicFunction', true],
        ['publicArrow', true],
        ['PublicClass', true],
        ...(extension === 'ts'
          ? ([
              ['publicAmbient', true],
              ['PublicAmbientClass', true],
            ] as const)
          : []),
        ['privateFunction', false],
        ...(extension === 'ts'
          ? ([
              ['privateAmbient', false],
              ['PrivateAmbientClass', false],
            ] as const)
          : []),
        ['nestedFunction', false],
        ['nestedArrow', false],
        ['arrowLocal', false],
        ['member', false],
        ['methodLocal', false],
        ['objectMember', false],
      ] as const) {
        const symbols = nodes.filter((node) => node.properties.name === name);
        expect(symbols.length, name).toBeGreaterThan(0);
        expect(
          symbols.map((node) => node.properties.isExported),
          name,
        ).toEqual(symbols.map(() => exported));
      }
    }
  });

  it('preserves destructured export metadata through the compiled TS/JS worker', async () => {
    expect(fs.existsSync(DIST_WORKER)).toBe(true);
    pool = createWorkerPool(pathToFileURL(DIST_WORKER), 1, { cooperativeShutdown: true });
    const inputs = ['ts', 'js'].flatMap((extension) => [
      {
        path: `base.${extension}`,
        content:
          'export const { value, key: local = fallback } = source; export const [item] = source; const { privateName } = source;',
      },
      { path: `app.${extension}`, content: `import * as ns from './base.${extension}';` },
    ]);
    const results = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>(inputs);
    const imports = results.flatMap((result) => result.imports);
    for (const extension of ['ts', 'js']) {
      expect(
        imports
          .filter((record) => record.filePath === `base.${extension}` && record.isLocalExport)
          .flatMap((record) => record.namedBindings ?? []),
      ).toEqual(
        ['value', 'local', 'item'].map((name) => ({
          local: `#local-export:${name}`,
          exported: name,
        })),
      );
    }
    const serial = createResolutionContext();
    const worker = createResolutionContext();
    const cache = createASTCache(10);
    try {
      for (const context of [serial, worker]) {
        for (const extension of ['ts', 'js']) {
          for (const name of ['value', 'local', 'item', 'privateName', 'key', 'fallback']) {
            // Seed symbols to isolate export visibility from variable type inference.
            context.model.symbols.add(
              `base.${extension}`,
              name,
              `${extension}:${name}`,
              'Variable',
            );
          }
        }
      }
      await processImports(createKnowledgeGraph(), inputs, cache, serial);
      await processImportsFromExtracted(createKnowledgeGraph(), inputs, imports, worker);
      expect(worker.namedImportMap).toEqual(serial.namedImportMap);
      for (const context of [serial, worker]) {
        for (const extension of ['ts', 'js']) {
          for (const name of ['value', 'local', 'item', 'privateName', 'key', 'fallback']) {
            expect(
              context
                .resolve(`ns.${name}`, `app.${extension}`)
                ?.candidates.map((def) => def.nodeId) ?? [],
            ).toEqual(['value', 'local', 'item'].includes(name) ? [`${extension}:${name}`] : []);
          }
        }
      }
    } finally {
      cache.clear();
      serial.clear();
      worker.clear();
    }
  });

  it.each(['thread', 'process'] as const)(
    'repeats four-worker native startup, dispatch and teardown (%s)',
    async (isolation) => {
      expect(
        fs.existsSync(DIST_WORKER),
        'Build the production dist/ worker before this integration suite',
      ).toBe(true);
      const inputs = [
        { path: 'native.js', content: 'function jsTarget() {}', name: 'jsTarget' },
        { path: 'native.ts', content: 'function tsTarget() {}', name: 'tsTarget' },
        { path: 'native.py', content: 'def pythonTarget():\n    pass\n', name: 'pythonTarget' },
        { path: 'native.cpp', content: 'void cppTarget() {}', name: 'cppTarget' },
        { path: 'native.rs', content: 'fn rust_target() {}', name: 'rust_target' },
        { path: 'native.go', content: 'package fixture\nfunc goTarget() {}\n', name: 'goTarget' },
      ];
      const expected = inputs
        .map(({ path, name }) => [path, name])
        .sort((left, right) => left[0]!.localeCompare(right[0]!));
      for (let cycle = 0; cycle < 3; cycle++) {
        pool = createWorkerPool(pathToFileURL(DIST_WORKER), 4, {
          isolation,
          cooperativeShutdown: true,
        });
        try {
          expect(pool.size).toBe(4);
          const results = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>(
            inputs.map(({ path, content }) => ({ path, content })),
          );
          expect(results.reduce((count, result) => count + result.fileCount, 0)).toBe(6);
          expect(
            results
              .flatMap((result) => result.nodes)
              .filter((node) => node.label === 'Function')
              .map((node) => [node.properties.filePath, node.properties.name])
              .sort((left, right) => left[0]!.localeCompare(right[0]!)),
          ).toEqual(expected);
        } finally {
          await pool.terminate();
          pool = undefined;
        }
      }
    },
    120000,
  );

  it.each([0, 20, 80, 160, 320])(
    'awaits four native workers shutting down during startup after %dms',
    async (delayMs) => {
      expect(
        fs.existsSync(DIST_WORKER),
        'Build the production dist/ worker before this integration suite',
      ).toBe(true);
      for (let cycle = 0; cycle < 2; cycle++) {
        pool = createWorkerPool(pathToFileURL(DIST_WORKER), 4, { cooperativeShutdown: true });
        expect(pool.size).toBe(4);
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const closingPool = pool;
        await expect(
          Promise.all([closingPool.terminate(), closingPool.terminate()]),
        ).resolves.toEqual([undefined, undefined]);
        await expect(closingPool.dispatch([])).rejects.toThrow('Worker pool is closed');
        pool = undefined;
      }
    },
    120000,
  );

  it('queues cooperative shutdown until a delayed handler initializes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-shutdown-'));
    const workerPath = path.join(tempDir, 'shutdown-worker.cjs');
    const eventsPath = path.join(tempDir, 'events.jsonl');
    fs.writeFileSync(
      workerPath,
      `
        const fs = require('node:fs');
        const { parentPort } = require('node:worker_threads');
        const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');
        record('started');
        setTimeout(() => {
          record('initialized');
          const receive = (message) => {
            record(message.type);
            if (message.type === 'shutdown') {
              parentPort.close();
            }
          };
          parentPort.on('message', receive);
        }, 80);
      `,
    );
    pool = createWorkerPool(pathToFileURL(workerPath), 1, { cooperativeShutdown: true });
    const closingPool = pool;
    try {
      await expect(
        Promise.all([closingPool.terminate(), closingPool.terminate()]),
      ).resolves.toEqual([undefined, undefined]);
      pool = undefined;
      expect(
        fs
          .readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual(['started', 'initialized', 'shutdown']);
      await expect(closingPool.dispatch([])).rejects.toThrow('Worker pool is closed');
      await expect(closingPool.dispatch([{ path: 'closed.ts', content: '' }])).rejects.toThrow(
        'Worker pool is closed',
      );
      await expect(closingPool.terminate()).resolves.toBeUndefined();
    } finally {
      await closingPool.terminate();
      pool = undefined;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it('does not replace a failing worker after concurrent termination', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-close-race-'));
    const workerPath = path.join(tempDir, 'shutdown-worker.cjs');
    const eventsPath = path.join(tempDir, 'events.jsonl');
    fs.writeFileSync(
      workerPath,
      `
        const fs = require('node:fs');
        const { parentPort } = require('node:worker_threads');
        const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');
        record('started');
        const send = (message) => parentPort.postMessage(message);
        const receive = (message) => {
          record(message.type);
          if (message.type === 'sub-batch') {
            send({ type: 'progress', filesProcessed: 0, filePath: 'failing.ts' });
          } else if (message.type === 'shutdown') {
            send({ type: 'error', error: 'failure while closing' });
            parentPort.close();
          }
        };
        parentPort.on('message', receive);
      `,
    );
    pool = createWorkerPool(pathToFileURL(workerPath), 1, { cooperativeShutdown: true });
    const closingPool = pool;
    let termination: Promise<void> | undefined;
    try {
      const dispatch = closingPool.dispatch([{ path: 'failing.ts', content: '' }], () => {
        termination = closingPool.terminate();
      });
      await expect(dispatch).rejects.toThrow('failure while closing');
      expect(termination).toBeDefined();
      await termination;
      pool = undefined;
      expect(
        fs
          .readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual(['started', 'sub-batch', 'shutdown']);
      await expect(closingPool.dispatch([])).rejects.toThrow('Worker pool is closed');
    } finally {
      await closingPool.terminate();
      pool = undefined;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it('replaces a timed-out cooperative worker once after its shutdown completes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-timeout-'));
    const workerPath = path.join(tempDir, 'shutdown-worker.cjs');
    const eventsPath = path.join(tempDir, 'events.jsonl');
    fs.writeFileSync(
      workerPath,
      `
      const fs = require('node:fs');
      const { parentPort } = require('node:worker_threads');
      const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');
      record('started');
      parentPort.on('message', (message) => {
        record(message.type);
        if (message.type === 'sub-batch') {
          if (message.files[0].path === 'timeout.ts') {
            parentPort.postMessage({ type: 'progress', filesProcessed: 0 });
          } else {
            parentPort.postMessage({ type: 'sub-batch-done' });
          }
        } else if (message.type === 'flush') {
          parentPort.postMessage({ type: 'result', data: { fileCount: 1 } });
        } else if (message.type === 'shutdown') {
          parentPort.close();
        }
      });
    `,
    );
    pool = createWorkerPool(pathToFileURL(workerPath), 1, { cooperativeShutdown: true });
    const timeoutPool = pool;
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const dispatch = timeoutPool.dispatch([{ path: 'timeout.ts', content: '' }], () => ready());
      const rejected = expect(dispatch).rejects.toThrow('timed out');
      await started;
      await vi.advanceTimersByTimeAsync(WORKER_SUB_BATCH_TIMEOUT_MS);
      await rejected;
      vi.useRealTimers();
      await expect(timeoutPool.dispatch([{ path: 'recovered.ts', content: '' }])).resolves.toEqual([
        { fileCount: 1 },
      ]);
      await timeoutPool.terminate();
      pool = undefined;
      expect(
        fs
          .readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual(['started', 'sub-batch', 'shutdown', 'started', 'sub-batch', 'flush', 'shutdown']);
    } finally {
      vi.useRealTimers();
      await timeoutPool.terminate();
      pool = undefined;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it('forces an unresponsive cooperative worker to exit at the shutdown deadline', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-shutdown-timeout-'));
    const workerPath = path.join(tempDir, 'shutdown-worker.cjs');
    const eventsPath = path.join(tempDir, 'events.jsonl');
    fs.writeFileSync(
      workerPath,
      `
      const fs = require('node:fs');
      const { parentPort } = require('node:worker_threads');
      const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n');
      record('started');
      parentPort.on('message', (message) => {
        record(message.type);
        if (message.type === 'sub-batch') {
          parentPort.postMessage({ type: 'progress', filesProcessed: 0, filePath: 'hung.ts' });
        }
        // Deliberately ignore shutdown so the bounded fallback must terminate this thread.
      });
    `,
    );
    pool = createWorkerPool(pathToFileURL(workerPath), 1, { cooperativeShutdown: true });
    const closingPool = pool;
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const dispatch = closingPool.dispatch([{ path: 'hung.ts', content: '' }], () => ready());
      const rejected = expect(dispatch).rejects.toThrow();
      await started;

      const termination = closingPool.terminate();
      const repeatedTermination = closingPool.terminate();
      expect(repeatedTermination).toBe(termination);
      // Let the real worker thread receive the queued shutdown before the fake deadline fires.
      await vi.waitFor(
        () => {
          expect(fs.readFileSync(eventsPath, 'utf8')).toContain('"shutdown"');
        },
        { timeout: 5_000, interval: 10 },
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(termination).resolves.toBeUndefined();
      await rejected;
      await expect(closingPool.dispatch([])).rejects.toThrow('Worker pool is closed');
      expect(
        fs
          .readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual(['started', 'sub-batch', 'shutdown']);
      expect(vi.getTimerCount()).toBe(0);
      pool = undefined;
    } finally {
      vi.useRealTimers();
      await closingPool.terminate();
      pool = undefined;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000);

  it.skipIf(!hasDistWorker)('creates a worker pool from dist/ worker', () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });
    expect(pool.size).toBe(1);
  });

  it.skipIf(!hasDistWorker)('dispatches an empty batch without error', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });
    const results = await pool.dispatch([]);
    expect(results).toEqual([]);
  });

  it.skipIf(!hasDistWorker)('parses a single TypeScript file through worker', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

    const fixtureFile = path.resolve(
      __dirname,
      '..',
      'fixtures',
      'mini-repo',
      'src',
      'validator.ts',
    );
    const content = fs.readFileSync(fixtureFile, 'utf-8');

    const results = await pool.dispatch<any, any>([{ path: 'src/validator.ts', content }]);

    // Worker returns an array of results (one per worker chunk)
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.fileCount).toBe(1);
    expect(result.nodes.length).toBeGreaterThan(0);

    // Should find the validateInput function
    const names = result.nodes.map((n: any) => n.properties.name);
    expect(names).toContain('validateInput');
  });

  it.skipIf(!hasDistWorker)(
    'reports AST resource fallback as skipped without syntax errors',
    async () => {
      const originalCap = process.env.ONTOINDEX_PARSE_MAX_AST_NODES;
      process.env.ONTOINDEX_PARSE_MAX_AST_NODES = '5';
      try {
        pool = createWorkerPool(pathToFileURL(DIST_WORKER), 1, { cooperativeShutdown: true });
        const results = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>([
          {
            path: 'guarded.ts',
            content: 'export function guarded() { return 1; }',
          },
        ]);
        expect(results.flatMap((result) => result.fileTimings)).toEqual([
          expect.objectContaining({ filePath: 'guarded.ts', status: 'skipped' }),
        ]);
        expect(results.flatMap((result) => result.parseErrorPaths)).toEqual([]);
      } finally {
        await pool?.terminate();
        pool = undefined;
        if (originalCap === undefined) delete process.env.ONTOINDEX_PARSE_MAX_AST_NODES;
        else process.env.ONTOINDEX_PARSE_MAX_AST_NODES = originalCap;
      }
    },
  );

  it.skipIf(!hasDistWorker)('can stream result parts without retaining them', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

    const fixtureFile = path.resolve(
      __dirname,
      '..',
      'fixtures',
      'mini-repo',
      'src',
      'validator.ts',
    );
    const content = fs.readFileSync(fixtureFile, 'utf-8');
    const streamedCounts: number[] = [];

    const results = await pool.dispatch<any, ReturnType<typeof createEmptyResult>>(
      [{ path: 'src/validator.ts', content }],
      undefined,
      undefined,
      undefined,
      {
        collectResultParts: false,
        createEmptyResult,
        onResultPart: (part) => {
          streamedCounts.push(part.nodes.length);
          part.nodes.length = 0;
          part.relationships.length = 0;
          part.symbols.length = 0;
        },
      },
    );

    expect(streamedCounts.some((count) => count > 0)).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].nodes).toHaveLength(0);
    expect(results[0].relationships).toHaveLength(0);
    expect(results[0].symbols).toHaveLength(0);
  });

  it.skipIf(!hasDistWorker)(
    'parses a single TypeScript file through process isolation',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1, { isolation: 'process', cooperativeShutdown: true });

      const fixtureFile = path.resolve(
        __dirname,
        '..',
        'fixtures',
        'mini-repo',
        'src',
        'validator.ts',
      );
      const content = fs.readFileSync(fixtureFile, 'utf-8');

      const results = await pool.dispatch<any, any>([{ path: 'src/validator.ts', content }]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.fileCount).toBe(1);
      const names = result.nodes.map((n: any) => n.properties.name);
      expect(names).toContain('validateInput');
    },
  );

  it.skipIf(!hasDistWorker)(
    'uses route-model pack file patterns to trigger route extraction before provider defaults',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

      const content = `
        <?php
        use Illuminate\\Support\\Facades\\Route;
        Route::get('/shadow-users', [UserController::class, 'index']);
      `;

      const results = await pool.dispatch<any, any>([
        {
          path: 'custom/http/shadow-routes.php',
          content,
          routeFilePatterns: ['custom/http/**/*.php'],
        },
      ]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.routes).toHaveLength(1);
      expect(result.routes[0]).toMatchObject({
        filePath: 'custom/http/shadow-routes.php',
        routePath: '/shadow-users',
        httpMethod: 'get',
      });
    },
  );

  it.skipIf(!hasDistWorker)(
    'uses component-model pack file patterns to trigger JSX component extraction before extension defaults',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

      const content = `
        import React from 'react';

        export function LegacyView() {
          return <UserCard title="Users" />;
        }
      `;

      const results = await pool.dispatch<any, any>([
        {
          path: 'custom/components/legacy-view.js',
          content,
          componentFilePatterns: ['custom/components/**/*.js'],
        },
      ]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filePath: 'custom/components/legacy-view.js',
            calledName: 'UserCard',
            sourceId: 'File:custom/components/legacy-view.js',
            callForm: 'free',
          }),
        ]),
      );
    },
  );

  it.skipIf(!hasDistWorker)(
    'uses orm-model pack client identifiers to extract ORM queries before hard-coded client names',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

      const content = `
        export async function listUsers() {
          return db.user.findMany({ where: { active: true } });
        }

        export async function listBookings() {
          return adminDb.from('bookings').select('*');
        }
      `;

      const results = await pool.dispatch<any, any>([
        {
          path: 'custom/data/orm-aliases.ts',
          content,
          prismaClientIdentifiers: ['db'],
          supabaseClientIdentifiers: ['adminDb'],
        },
      ]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.ormQueries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filePath: 'custom/data/orm-aliases.ts',
            orm: 'prisma',
            model: 'user',
            method: 'findMany',
          }),
          expect.objectContaining({
            filePath: 'custom/data/orm-aliases.ts',
            orm: 'supabase',
            model: 'bookings',
            method: 'select',
          }),
        ]),
      );
    },
  );

  it.skipIf(!hasDistWorker)(
    'emits method call source IDs that match suffixed method node IDs',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

      const content = `
        const phase = {
          async execute(ctx: unknown, deps: unknown) {
            return helper();
          },
        };

        function helper() {
          return true;
        }
      `;

      const results = await pool.dispatch<any, any>([{ path: 'src/phase.ts', content }]);

      expect(results).toHaveLength(1);
      const result = results[0];
      const executeNode = result.nodes.find((n: any) => n.properties.name === 'execute');
      const helperCall = result.calls.find((c: any) => c.calledName === 'helper');

      expect(executeNode?.id).toBe('Method:src/phase.ts:execute#2');
      expect(helperCall?.sourceId).toBe(executeNode?.id);
    },
  );

  it.skipIf(!hasDistWorker)(
    'captures async generator function definitions used as call sources',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

      const content = `
        export async function* streamAgentResponse(messages: string[]) {
          yield formatChunk(messages);
        }

        function formatChunk(messages: string[]) {
          return messages.join(',');
        }
      `;

      const results = await pool.dispatch<any, any>([{ path: 'src/agent.ts', content }]);

      expect(results).toHaveLength(1);
      const result = results[0];
      const streamNode = result.nodes.find((n: any) => n.properties.name === 'streamAgentResponse');
      const helperCall = result.calls.find((c: any) => c.calledName === 'formatChunk');

      expect(streamNode?.id).toBe('Function:src/agent.ts:streamAgentResponse');
      expect(helperCall?.sourceId).toBe(streamNode?.id);
    },
  );

  it.skipIf(!hasDistWorker)('parses multiple files across workers', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 2, { cooperativeShutdown: true });

    const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'mini-repo', 'src');
    const files = fs
      .readdirSync(fixturesDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({
        path: `src/${f}`,
        content: fs.readFileSync(path.join(fixturesDir, f), 'utf-8'),
      }));

    expect(files.length).toBeGreaterThanOrEqual(4);

    const results = await pool.dispatch<any, any>(files);

    // Each worker chunk returns a result
    expect(results.length).toBeGreaterThan(0);

    // Total files parsed should match input
    const totalParsed = results.reduce((sum: number, r: any) => sum + r.fileCount, 0);
    expect(totalParsed).toBe(files.length);

    // Should find symbols from multiple files
    const allNames = results.flatMap((r: any) => r.nodes.map((n: any) => n.properties.name));
    expect(allNames).toContain('handleRequest');
    expect(allNames).toContain('validateInput');
    expect(allNames).toContain('saveToDb');
    expect(allNames).toContain('formatResponse');
  });

  it.skipIf(!hasDistWorker)('reports progress during parsing', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

    const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'mini-repo', 'src');
    const files = fs
      .readdirSync(fixturesDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({
        path: `src/${f}`,
        content: fs.readFileSync(path.join(fixturesDir, f), 'utf-8'),
      }));

    const progressCalls: number[] = [];
    await pool.dispatch<any, any>(files, (filesProcessed) => {
      progressCalls.push(filesProcessed);
    });

    // Progress callbacks are best-effort — with a small batch the worker may
    // process all files before the progress message is delivered. Just verify
    // that if progress was reported, the values are sensible.
    if (progressCalls.length > 0) {
      expect(progressCalls[progressCalls.length - 1]).toBe(files.length);
    }
  });

  it.skipIf(!hasDistWorker)('terminates cleanly', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 2, { cooperativeShutdown: true });
    await pool.terminate();
    pool = undefined; // already terminated
  });

  it('fails gracefully with invalid worker path', () => {
    const badUrl = pathToFileURL('/nonexistent/worker.js') as URL;
    // createWorkerPool validates the worker script exists before spawning
    expect(() => {
      pool = createWorkerPool(badUrl, 1);
    }).toThrow(/Worker script not found/);
  });

  // ─── Unhappy paths ──────────────────────────────────────────────────

  it('throws when a worker thread encounters an error', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-error-'));
    const workerPath = path.join(tempDir, 'error-worker.js');
    fs.writeFileSync(
      workerPath,
      `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          parentPort.postMessage({
            type: 'diagnostic',
            diagnostics: {
              ...msg.diagnostics,
              phase: 'process-file',
              currentFilePath: 'error.ts',
            },
          });
          parentPort.postMessage({ type: 'error', error: 'Simulated worker crash' });
        }
      });
    `,
    );

    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1);

    try {
      await expect(
        pool.dispatch<any, any>([{ path: 'error.ts', content: 'const x = 1;' }]),
      ).rejects.toThrow(
        /Simulated worker crash.*sub-batch: 1 size 1.*current file: error\.ts.*active: file error\.ts/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports child-process exits with active parse context', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-process-exit-'));
    const workerPath = path.join(tempDir, 'exit-worker.js');
    fs.writeFileSync(
      workerPath,
      `
      process.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          process.send({
            type: 'diagnostic',
            diagnostics: {
              ...msg.diagnostics,
              phase: 'process-file',
              currentFilePath: 'native-panic.ts',
            },
          });
          process.exit(134);
        }
      });
    `,
    );

    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1, { isolation: 'process' });

    try {
      await expect(
        pool.dispatch<any, any>([{ path: 'native-panic.ts', content: 'const x = 1;' }]),
      ).rejects.toThrow(
        /Worker 0 exited with code 134.*sub-batch: 1 size 1.*current file: native-panic\.ts.*active: file native-panic\.ts.*native addon failure/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('escalates child-process termination when SIGTERM is ignored', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-process-kill-'));
    const workerPath = path.join(tempDir, 'ignore-term-worker.js');
    fs.writeFileSync(
      workerPath,
      `
      process.on('SIGTERM', () => {});
      process.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          process.send({ type: 'sub-batch-done' });
          return;
        }
        if (msg && msg.type === 'flush') {
          process.send({ type: 'result', data: { items: [] } });
        }
      });
      setInterval(() => {}, 1000);
    `,
    );

    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1, { isolation: 'process' });

    try {
      await pool.dispatch<any, any>([{ path: 'ignored-term.ts', content: 'const x = 1;' }]);
      const started = Date.now();
      await pool.terminate();
      pool = undefined;
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 7_000);

  it('emits process isolation startup metadata on worker events', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-process-meta-'));
    const workerPath = path.join(tempDir, 'metadata-worker.js');
    fs.writeFileSync(
      workerPath,
      `
      process.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          process.send({ type: 'sub-batch-done' });
          return;
        }
        if (msg && msg.type === 'flush') {
          process.send({ type: 'result', data: { items: [] } });
        }
      });
    `,
    );

    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1, { isolation: 'process' });
    const subBatchEvents: any[] = [];
    const resultEvents: any[] = [];

    try {
      await pool.dispatch<any, any>(
        [{ path: 'metadata.ts', content: 'const x = 1;' }],
        undefined,
        (event) => subBatchEvents.push(event),
        (event) => resultEvents.push(event),
      );

      expect(pool.isolation).toBe('process');
      expect(pool.startupDurationMs).toBeGreaterThanOrEqual(0);
      expect(pool.workerStartupDurationsMs).toHaveLength(1);
      expect(subBatchEvents[0]).toMatchObject({
        workerIsolation: 'process',
        workerIndex: 0,
      });
      expect(subBatchEvents[0].workerStartupDurationMs).toBeGreaterThanOrEqual(0);
      expect(resultEvents[0]).toMatchObject({
        workerIsolation: 'process',
        workerIndex: 0,
      });
      expect(resultEvents[0].workerStartupDurationMs).toBeGreaterThanOrEqual(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasDistWorker)('dispatch after terminate rejects', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });
    const terminatedPool = pool;
    await terminatedPool.terminate();
    pool = undefined; // already terminated — prevent afterEach double-terminate

    await expect(
      terminatedPool.dispatch([{ path: 'x.ts', content: 'const x = 1;' }]),
    ).rejects.toThrow();
  });

  it.skipIf(!hasDistWorker)('double terminate does not throw', async () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });
    await pool.terminate();
    await expect(pool.terminate()).resolves.toBeUndefined();
    pool = undefined;
  });

  it.skipIf(!hasDistWorker)(
    'dispatches entries with empty content string without crashing',
    async () => {
      const workerUrl = pathToFileURL(DIST_WORKER) as URL;
      pool = createWorkerPool(workerUrl, 1, { cooperativeShutdown: true });

      const results = await pool.dispatch<any, any>([{ path: 'empty.ts', content: '' }]);

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(typeof result.fileCount).toBe('number');
      expect(result.fileCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.nodes)).toBe(true);
    },
  );

  it('treats warning messages as non-terminal and still resolves the worker result', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-worker-warning-'));
    const workerPath = path.join(tempDir, 'warning-worker.js');
    fs.writeFileSync(
      workerPath,
      `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (msg) => {
        if (msg && msg.type === 'sub-batch') {
          parentPort.postMessage({ type: 'warning', message: 'warning before result' });
          parentPort.postMessage({ type: 'sub-batch-done' });
          return;
        }
        if (msg && msg.type === 'flush') {
          parentPort.postMessage({ type: 'result', data: { nodes: [], relationships: [], symbols: [], imports: [], calls: [], heritage: [], routes: [], fileCount: 1 } });
        }
      });
    `,
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const workerUrl = pathToFileURL(workerPath) as URL;
    pool = createWorkerPool(workerUrl, 1);

    try {
      const results = await pool.dispatch<any, any>([
        { path: 'warning.ts', content: 'const x = 1;' },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].fileCount).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith('warning before result');
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasDistWorker)('createWorkerPool with size 0 creates pool with zero workers', () => {
    const workerUrl = pathToFileURL(DIST_WORKER) as URL;
    const zeroPool = createWorkerPool(workerUrl, 0, { cooperativeShutdown: true });
    expect(zeroPool.size).toBe(0);
    return zeroPool.terminate();
  });
});
