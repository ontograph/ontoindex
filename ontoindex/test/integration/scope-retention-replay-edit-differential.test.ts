import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { parsePhase } from '../../src/core/ingestion/pipeline-phases/parse.js';
import { reconstructScopeRetentionParse } from '../../src/core/ingestion/pipeline-phases/parse-replay.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { BindingAccumulator } from '../../src/core/ingestion/binding-accumulator.js';
import { restoreSemanticModelRegistrations } from '../../src/core/ingestion/model/semantic-model.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import { buildHeritageMap } from '../../src/core/ingestion/model/heritage-map.js';
import { getHeritageStrategyForLanguage } from '../../src/core/ingestion/heritage-processor.js';
import {
  processCallsFromExtracted,
  seedCrossFileReceiverTypes,
} from '../../src/core/ingestion/call-processor.js';
import { processAssignmentsFromExtracted } from '../../src/core/ingestion/call-resolution/assignment-processor.js';
import { persistScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js';
import type { verifyScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js';
import {
  loadPersistedReplayFamilies,
  type ReplayFamilies,
} from '../helpers/scope-retention-replay.js';

function snapshot(graph: KnowledgeGraph) {
  return {
    nodes: structuredClone(graph.nodes).sort((left, right) => left.id.localeCompare(right.id)),
    relationships: structuredClone(graph.relationships).sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

type Families = ReplayFamilies;

async function replay(input: Families) {
  // Receiver seeding can mutate calls; variants must start from identical records.
  const families = structuredClone(input);
  const {
    calls,
    assignments,
    constructors,
    heritage,
    fileBindings,
    exportedTypes,
    events,
    importStates,
    declarationNodes,
    structuralRelationships,
  } = families;
  const bindings = new BindingAccumulator();
  const context = createResolutionContext({
    model: restoreSemanticModelRegistrations({ version: 1, events }),
    importState: importStates[0]!,
  });
  try {
    const graph = createKnowledgeGraph();
    for (const node of declarationNodes) graph.addNode(node);
    for (const edge of structuralRelationships) graph.addRelationship(edge);
    for (const { filePath, varName, typeName } of fileBindings) {
      bindings.appendFile(filePath, [{ scope: '', varName, typeName }]);
    }
    bindings.finalize();
    const exportedTypeMap = new Map<string, Map<string, string>>();
    for (const { filePath, exportName, typeName } of exportedTypes) {
      if (!exportedTypeMap.has(filePath)) exportedTypeMap.set(filePath, new Map());
      exportedTypeMap.get(filePath)!.set(exportName, typeName);
    }
    seedCrossFileReceiverTypes(calls, context.namedImportMap, exportedTypeMap);
    await processCallsFromExtracted(
      graph,
      calls,
      context,
      undefined,
      constructors,
      buildHeritageMap(heritage, context, getHeritageStrategyForLanguage),
      bindings,
    );
    processAssignmentsFromExtracted(graph, assignments, context, constructors, bindings);
    return snapshot(graph);
  } finally {
    context.clear();
    bindings.dispose();
  }
}

async function captureFamilies(directory: string) {
  const generationDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ontoindex-retention-edit-candidate-'),
  );
  let expected: Parameters<typeof verifyScopeRetentionCandidate>[1] | undefined;
  let producer: ReturnType<typeof snapshot> | undefined;
  const executeParse = parsePhase.execute;
  const parseSpy = vi.spyOn(parsePhase, 'execute').mockImplementation(async (ctx, deps) => {
    const output = await executeParse(ctx, deps);
    producer = snapshot(ctx.graph);
    return output;
  });
  try {
    await runPipelineFromRepo(directory, () => {}, {
      skipWorkers: true,
      skipGraphPhases: true,
      scopeRetention: {
        deadline: Date.now() + 60_000,
        artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
        consume: async (handle) => {
          expect(handle.seedReady).toBe(false);
          expected = {
            identity: {
              sourceManifestDigest: 'a'.repeat(64),
              targetCommit: 'head',
              baseGenerationId: null,
            },
            parserCodeIdentity: handle.inputEvidence.parserCodeIdentity,
          };
          const manifest = await persistScopeRetentionCandidate(
            handle,
            generationDirectory,
            expected.identity,
            {
              deadline: Date.now() + 60_000,
              artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
            },
          );
          expect(manifest.seedReady).toBe(false);
        },
      },
    });
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(producer).toBeDefined();
    expect(expected).toBeDefined();
    // The pipeline has disposed its live handle before persisted bytes are decoded.
    const families = await loadPersistedReplayFamilies(generationDirectory, expected!);
    expect(families.importStates).toHaveLength(1);
    return { families, producer: producer! };
  } finally {
    parseSpy.mockRestore();
    fs.rmSync(generationDirectory, { recursive: true, force: true });
  }
}

function compose(base: Families, edited: Families, changedPaths: readonly string[]): Families {
  const changed = new Set(changedPaths);
  const splice = <T extends { filePath: string }>(before: T[], after: T[]) => [
    ...before.filter(({ filePath }) => !changed.has(filePath)),
    ...after.filter(({ filePath }) => changed.has(filePath)),
  ];
  const nodeFiles = new Map(
    [...base.declarationNodes, ...edited.declarationNodes].map(
      (node) => [node.id, node.properties.filePath] as const,
    ),
  );
  const touchesChanged = (edge: Families['structuralRelationships'][number]) =>
    changed.has(nodeFiles.get(edge.sourceId) ?? '') ||
    changed.has(nodeFiles.get(edge.targetId) ?? '');
  return {
    parsedFiles: splice(base.parsedFiles, edited.parsedFiles),
    calls: splice(base.calls, edited.calls),
    assignments: splice(base.assignments, edited.assignments),
    constructors: splice(base.constructors, edited.constructors),
    heritage: splice(base.heritage, edited.heritage),
    fileBindings: splice(base.fileBindings, edited.fileBindings),
    exportedTypes: splice(base.exportedTypes, edited.exportedTypes),
    events: [
      ...base.events.filter((event) => event.kind === 'symbol.add' && !changed.has(event.filePath)),
      ...edited.events.filter(
        (event) => event.kind !== 'symbol.add' || changed.has(event.filePath),
      ),
    ],
    // Non-symbol registrations have no top-level file key: take their whole edited
    // subsequence, including type registrations for class fixtures.
    // Imports are a workspace snapshot, not composable per-file records.
    importStates: base.importStates,
    declarationNodes: [
      ...base.declarationNodes.filter((node) => !changed.has(node.properties.filePath)),
      ...edited.declarationNodes.filter((node) => changed.has(node.properties.filePath)),
    ],
    structuralRelationships: [
      ...base.structuralRelationships.filter((edge) => !touchesChanged(edge)),
      ...edited.structuralRelationships.filter(touchesChanged),
    ],
  };
}

const main =
  [
    "import { helper, other as renamed } from './util';",
    'function run() {',
    '  helper();',
    '  renamed();',
    '  missing();',
    '}',
    'export function entry() { run(); }',
  ].join('\n') + '\n';
const fixture: Record<string, string> = {
  'src/util.ts': 'export function helper() {}\nexport function other() {}\n',
  'src/main.ts': main,
  'src/extra.ts': "import { helper } from './util';\nexport function extra() { helper(); }\n",
};
const variants = ['base-import-state', 'edited-import-state'] as const;
const pythonFixture: Record<string, string> = {
  'src/main.py': 'def target():\n    pass\n\ndef entry():\n    target()\n',
  'src/stable.py': 'def stable_target():\n    pass\n\ndef stable_entry():\n    stable_target()\n',
  'src/extra.py': 'def extra_target():\n    pass\n\ndef extra_entry():\n    extra_target()\n',
};
const scenarios: {
  name: string;
  base?: Record<string, string>;
  edits: Record<string, string | null>;
}[] = [
  {
    name: 'python-body-only',
    base: pythonFixture,
    edits: {
      'src/main.py': 'def target():\n    pass\n\ndef entry():\n    pass\n',
    },
  },
  {
    name: 'python-rename-declaration-and-callers',
    base: pythonFixture,
    edits: {
      'src/main.py': 'def renamed():\n    pass\n\ndef entry():\n    renamed()\n',
    },
  },
  { name: 'python-delete-file', base: pythonFixture, edits: { 'src/extra.py': null } },
  {
    name: 'python-add-same-name-file',
    base: pythonFixture,
    edits: {
      'src/late.py': 'def target():\n    pass\n\ndef late_entry():\n    target()\n',
    },
  },
  { name: 'body-only', edits: { 'src/main.ts': main.replace('  renamed();\n', '') } },
  {
    name: 'add-export',
    edits: { 'src/util.ts': fixture['src/util.ts'] + 'export function missing() {}\n' },
  },
  {
    name: 'add-export-for-existing-unresolved-import',
    base: {
      'src/util.ts': 'export function helper() {}\n',
      'src/main.ts': "import { added } from './util';\nexport function entry() { added(); }\n",
    },
    edits: { 'src/util.ts': 'export function helper() {}\nexport function added() {}\n' },
  },
  {
    name: 'remove-export-for-existing-import',
    base: {
      'src/util.ts': 'export function removed() {}\n',
      'src/main.ts': "import { removed } from './util';\nexport function entry() { removed(); }\n",
    },
    edits: { 'src/util.ts': '' },
  },
  {
    name: 'rename-export',
    edits: { 'src/util.ts': fixture['src/util.ts']!.replace('other', 'another') },
  },
  { name: 'delete-file', edits: { 'src/extra.ts': null } },
  {
    name: 'new-import',
    edits: {
      'src/util.ts': fixture['src/util.ts'] + 'export function missing() {}\n',
      'src/main.ts': main.replace('other as renamed }', 'other as renamed, missing }'),
    },
  },
  // New file, not imported by main.ts: only a global same-name lookup could resolve missing().
  { name: 'new-global-candidate', edits: { 'src/late.ts': 'export function missing() {}\n' } },
  {
    name: 'class-new',
    base: {
      'src/a.ts': 'export class A {}\n',
      'src/b.ts': "import { A } from './a';\nexport function g() { new A(); }\n",
    },
    edits: { 'src/a.ts': 'export class B {}\n' },
  },
  {
    name: 'namespace-member',
    base: {
      'src/a.ts': 'export function f() {}\nexport function h() {}\n',
      'src/b.ts': "import * as ns from './a';\nexport function g() { ns.f(); ns.h(); }\n",
    },
    edits: { 'src/a.ts': 'export function f() {}\n' },
  },
  {
    name: 'index-dir',
    base: {
      'src/lib/index.ts': 'export function f() {}\n',
      'src/b.ts': "import { f } from './lib';\nexport function g() { f(); }\n",
    },
    edits: { 'src/lib/index.ts': 'export function f2() {}\n' },
  },
  {
    name: 'sibling-dir',
    base: {
      'pkg/a.ts': 'export function f() {}\n',
      'src/b.ts': "import { f } from '../pkg/a';\nexport function g() { f(); }\n",
    },
    edits: { 'pkg/a.ts': 'export function f2() {}\n' },
  },
  {
    name: 'same-name-delete-other',
    base: {
      'src/a.ts': 'export function f() {}\n',
      'src/c.ts': 'export function f() {}\n',
      'src/b.ts': "import { f } from './a';\nexport function g() { f(); }\n",
    },
    edits: { 'src/a.ts': null },
  },
  // Type-only exporters are retained with an empty export surface; a value import of a type name
  // must still resolve exactly as a full run does when the file turns into a value export or back.
  {
    name: 'type-only-to-value',
    base: {
      'src/t.ts': 'export type T = number;\n',
      'src/b.ts': "import { T } from './t';\nexport function g() { T(); }\n",
    },
    edits: { 'src/t.ts': 'export function T() {}\n' },
  },
  {
    name: 'value-to-type-only',
    base: {
      'src/t.ts': 'export function T() {}\n',
      'src/b.ts': "import { T } from './t';\nexport function g() { T(); }\n",
    },
    edits: { 'src/t.ts': 'export type T = number;\n' },
  },
  {
    name: 'same-name-add-duplicate',
    base: {
      'src/a.ts': 'export function f() {}\n',
      'src/b.ts': "import { f } from './a';\nexport function g() { f(); }\n",
    },
    edits: { 'src/c.ts': 'export function f() {}\n' },
  },
];
// Pin outcomes, including divergences if observed; this is not seed admission.
const expected: Record<string, 'match' | 'diverge'> = {
  'python-body-only/base-import-state': 'match',
  'python-body-only/edited-import-state': 'match',
  'python-rename-declaration-and-callers/base-import-state': 'match',
  'python-rename-declaration-and-callers/edited-import-state': 'match',
  'python-delete-file/base-import-state': 'match',
  'python-delete-file/edited-import-state': 'match',
  'python-add-same-name-file/base-import-state': 'match',
  'python-add-same-name-file/edited-import-state': 'match',
  'body-only/base-import-state': 'match',
  'body-only/edited-import-state': 'match',
  'add-export/base-import-state': 'match',
  'add-export/edited-import-state': 'match',
  'add-export-for-existing-unresolved-import/base-import-state': 'match',
  'add-export-for-existing-unresolved-import/edited-import-state': 'match',
  'remove-export-for-existing-import/base-import-state': 'match',
  'remove-export-for-existing-import/edited-import-state': 'match',
  'rename-export/base-import-state': 'match',
  'rename-export/edited-import-state': 'match',
  'delete-file/base-import-state': 'match',
  'delete-file/edited-import-state': 'match',
  'new-import/base-import-state': 'match',
  'new-import/edited-import-state': 'match',
  'new-global-candidate/base-import-state': 'match',
  'new-global-candidate/edited-import-state': 'match',
  'class-new/base-import-state': 'match',
  'class-new/edited-import-state': 'match',
  'namespace-member/base-import-state': 'match',
  'namespace-member/edited-import-state': 'match',
  'index-dir/base-import-state': 'match',
  'index-dir/edited-import-state': 'match',
  'sibling-dir/base-import-state': 'match',
  'sibling-dir/edited-import-state': 'match',
  'same-name-delete-other/base-import-state': 'match',
  'same-name-delete-other/edited-import-state': 'match',
  'type-only-to-value/base-import-state': 'match',
  'type-only-to-value/edited-import-state': 'match',
  'value-to-type-only/base-import-state': 'match',
  'value-to-type-only/edited-import-state': 'match',
  'same-name-add-duplicate/base-import-state': 'match',
  'same-name-add-duplicate/edited-import-state': 'match',
};

describe.sequential('scope retention replay after edits', () => {
  const directories: string[] = [];
  afterAll(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });
  const writeFixture = (files: Record<string, string>) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-retention-edit-'));
    directories.push(directory);
    for (const [file, contents] of Object.entries(files)) {
      const target = path.join(directory, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    return directory;
  };
  it.each(['ts', 'js'])(
    'restores public namespace heritage from persisted %s records',
    async (ext) => {
      const captured = await captureFamilies(
        writeFixture({
          [`base.${ext}`]: 'export class Base { greet() {} } export class Decoy { greet() {} }',
          [`barrel.${ext}`]:
            "import { Base as Local } from './base'; export { Local as Public }; export { Decoy as Local } from './base'; class Private { greet() {} }",
          [`app.${ext}`]: `import * as models from './barrel';
export class Child extends models.Public { inherited() { this.greet(); } }
`,
        }),
      );
      const graph = createKnowledgeGraph();
      const restored = await reconstructScopeRetentionParse(captured.families, graph);
      try {
        expect(snapshot(graph)).toEqual(captured.producer);
        expect(restored.resolutionContext.resolve('models.Private', `app.${ext}`)).toBeNull();
        expect(
          graph.relationships
            .filter((edge) => edge.type === 'EXTENDS' && graph.getNode(edge.targetId))
            .map((edge) => [edge.sourceId, edge.targetId]),
        ).toEqual([[`Class:app.${ext}:Child`, `Class:base.${ext}:Base`]]);
        expect(
          graph.relationships
            .filter(
              (edge) =>
                edge.type === 'CALLS' && graph.getNode(edge.targetId)?.properties.name === 'greet',
            )
            .map((edge) => [edge.sourceId, edge.targetId]),
        ).toEqual([[`Method:app.${ext}:Child.inherited#0`, `Method:base.${ext}:Base.greet#0`]]);
      } finally {
        restored.resolutionContext.clear();
        restored.bindingAccumulator.dispose();
      }
    },
    60000,
  );

  it.each(scenarios)(
    '$name compares reused records with a full edited run',
    async (scenario) => {
      const initial = scenario.base ?? fixture;
      const base = await captureFamilies(writeFixture(initial));
      expect(await replay(base.families)).toEqual(base.producer);
      if (scenario.name === 'python-body-only') {
        expect(await replay(base.families)).toEqual(base.producer);
      }
      const files: Record<string, string> = { ...initial };
      for (const [file, contents] of Object.entries(
        scenario.edits as Record<string, string | null>,
      )) {
        if (contents === null) delete files[file];
        else files[file] = contents;
      }
      const edited = await captureFamilies(writeFixture(files));
      expect(await replay(edited.families)).toEqual(edited.producer);
      expect(
        [base, edited].some(({ producer }) =>
          producer.relationships.some((edge: { type: string }) => edge.type === 'CALLS'),
        ),
        'one side must contain a call',
      ).toBe(true);
      expect(edited.producer, 'the edit must change the oracle').not.toEqual(base.producer);
      if (
        scenario.name === 'add-export-for-existing-unresolved-import' ||
        scenario.name === 'remove-export-for-existing-import'
      ) {
        const callsTo = (families: Families, graph: ReturnType<typeof snapshot>) => {
          const nodes = new Map(families.declarationNodes.map((node) => [node.id, node] as const));
          return graph.relationships.filter((edge: { type: string; targetId: string }) => {
            const target = nodes.get(edge.targetId);
            return (
              edge.type === 'CALLS' &&
              target?.properties.filePath === 'src/util.ts' &&
              target.properties.name ===
                (scenario.name === 'add-export-for-existing-unresolved-import'
                  ? 'added'
                  : 'removed')
            );
          });
        };
        if (scenario.name === 'add-export-for-existing-unresolved-import') {
          expect(
            callsTo(base.families, base.producer),
            'the base oracle leaves the import unresolved',
          ).toHaveLength(0);
          expect(
            callsTo(edited.families, edited.producer),
            'the edited oracle resolves the newly exported import',
          ).toHaveLength(1);
        } else {
          expect(
            callsTo(base.families, base.producer),
            'the base oracle resolves the existing export',
          ).toHaveLength(1);
          expect(
            callsTo(edited.families, edited.producer),
            'the edited oracle removes the call target with the export',
          ).toHaveLength(0);
        }
      }
      const combined = compose(base.families, edited.families, Object.keys(scenario.edits));
      expect(combined.parsedFiles.map(({ filePath }) => filePath).sort()).toEqual(
        Object.keys(files).sort(),
      );
      expect(combined.calls).toHaveLength(edited.families.calls.length);
      for (const variant of variants) {
        const candidate = await replay({
          ...combined,
          importStates:
            variant === 'base-import-state'
              ? base.families.importStates
              : edited.families.importStates,
        });
        const key = `${scenario.name}/${variant}`;
        if (scenario.name.startsWith('python-')) {
          const nodeFiles = new Map(
            edited.families.declarationNodes.map(
              (node) => [node.id, node.properties.filePath] as const,
            ),
          );
          for (const edge of candidate.relationships.filter(
            (edge: { type: string }) => edge.type === 'CALLS',
          )) {
            expect(nodeFiles.get(edge.sourceId), `${key}: caller must exist`).toBeDefined();
            expect(nodeFiles.get(edge.targetId), `${key}: calls stay in their own file`).toBe(
              nodeFiles.get(edge.sourceId),
            );
          }
        }
        if (expected[key] === 'match') expect(candidate, key).toEqual(edited.producer);
        else expect(candidate, key).not.toEqual(edited.producer);
      }
    },
    90_000,
  );
});
