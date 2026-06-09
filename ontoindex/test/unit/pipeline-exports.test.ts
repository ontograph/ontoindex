import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { buildPhaseList, runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type {
  OptionalPrecisionOutput,
  PipelineContext,
} from '../../src/core/ingestion/pipeline-phases/index.js';

describe('pipeline', () => {
  it('exports runPipelineFromRepo function', () => {
    expect(typeof runPipelineFromRepo).toBe('function');
  });

  it('keeps the default phase list unchanged', () => {
    expect(buildPhaseList().map((phase) => phase.name)).toEqual([
      'scan',
      'gitMining',
      'structure',
      'markdown',
      'cobol',
      'parse',
      'routes',
      'tools',
      'orm',
      'crossFile',
      'pageRank',
      'mro',
      'communities',
      'concepts',
      'processes',
      'summary-tree',
    ]);
  });

  it('keeps the explicit full profile phase list unchanged', () => {
    expect(buildPhaseList({ profile: 'full' }).map((phase) => phase.name)).toEqual(
      buildPhaseList().map((phase) => phase.name),
    );
  });

  it('builds the symbols profile as scan, structure, parse only', () => {
    const phases = buildPhaseList({ profile: 'symbols' });

    expect(phases.map((phase) => phase.name)).toEqual(['scan', 'structure', 'parse']);
    expect(phases.find((phase) => phase.name === 'parse')?.deps).toEqual(['structure']);
  });

  it('builds the huge-repo symbols profile as scan, structure, parse only', () => {
    const phases = buildPhaseList({ profile: 'huge-repo-symbols' });

    expect(phases.map((phase) => phase.name)).toEqual(['scan', 'structure', 'parse']);
    expect(phases.find((phase) => phase.name === 'parse')?.deps).toEqual(['structure']);
  });

  it('keeps scanned file metadata alive for symbols-only parsing', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-symbols-profile-'));
    try {
      await fs.writeFile(
        path.join(repoDir, 't.cxx'),
        [
          'class A { public: int f(); };',
          'int A::f(){ return 1; }',
          'int g(){ return A().f(); }',
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await runPipelineFromRepo(repoDir, () => {}, {
        profile: 'symbols',
        includePaths: ['t.cxx'],
      });
      const symbols: Array<{ label: string; name: string }> = [];
      result.graph.forEachNode((node) => {
        if (['Class', 'Method', 'Function'].includes(node.label)) {
          symbols.push({ label: node.label, name: String(node.properties.name) });
        }
      });

      expect(symbols).toEqual(
        expect.arrayContaining([
          { label: 'Class', name: 'A' },
          { label: 'Method', name: 'f' },
          { label: 'Function', name: 'g' },
        ]),
      );
      expect(
        symbols.filter((symbol) => symbol.label === 'Method' && symbol.name === 'f'),
      ).toHaveLength(1);

      const calls = [...result.graph.iterRelationships()]
        .filter((relationship) => relationship.type === 'CALLS')
        .map((relationship) => ({
          source: result.graph.getNode(relationship.sourceId)?.properties.name,
          target: result.graph.getNode(relationship.targetId)?.properties.name,
        }));
      expect(calls).toContainEqual({ source: 'g', target: 'f' });
      expect(calls.filter((call) => call.source === 'g').map((call) => call.target)).toEqual(['f']);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('merges split C++ header declarations with out-of-class source definitions', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-cpp-split-'));
    try {
      await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(repoDir, 'src/a.hxx'),
        ['class A { public: int f(); };', ''].join('\n'),
        'utf8',
      );
      await fs.writeFile(
        path.join(repoDir, 'src/a.cxx'),
        ['#include "a.hxx"', 'int A::f(){ return 1; }', 'int g(){ return A().f(); }', ''].join(
          '\n',
        ),
        'utf8',
      );

      const result = await runPipelineFromRepo(repoDir, () => {}, {
        profile: 'symbols',
        includePaths: ['src/a.hxx', 'src/a.cxx'],
      });
      const nodes = [...result.graph.iterNodes()];
      const symbols = nodes
        .filter((node) => ['Class', 'Method', 'Function'].includes(node.label))
        .map((node) => ({
          id: node.id,
          label: node.label,
          name: String(node.properties.name),
          filePath: String(node.properties.filePath),
        }));

      expect(symbols).toEqual(
        expect.arrayContaining([
          { id: expect.any(String), label: 'Class', name: 'A', filePath: 'src/a.hxx' },
          { id: expect.any(String), label: 'Method', name: 'f', filePath: expect.any(String) },
          { id: expect.any(String), label: 'Function', name: 'g', filePath: 'src/a.cxx' },
        ]),
      );
      expect(
        symbols.filter((symbol) => symbol.label === 'Method' && symbol.name === 'f'),
      ).toHaveLength(1);

      const classA = nodes.find(
        (node) =>
          node.label === 'Class' &&
          node.properties.name === 'A' &&
          node.properties.filePath === 'src/a.hxx',
      );
      const methodF = nodes.find((node) => node.label === 'Method' && node.properties.name === 'f');
      expect(classA).toBeDefined();
      expect(methodF).toBeDefined();
      expect(methodF!.properties).toMatchObject({
        filePath: 'src/a.cxx',
        startLine: 1,
        endLine: 1,
        declarationFilePath: 'src/a.hxx',
        declarationStartLine: 0,
        declarationEndLine: 0,
        definitionFilePath: 'src/a.cxx',
        definitionStartLine: 1,
        definitionEndLine: 1,
      });

      const relationships = [...result.graph.iterRelationships()];
      expect(relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceId: classA!.id,
            targetId: methodF!.id,
            type: 'HAS_METHOD',
          }),
        ]),
      );

      const calls = relationships
        .filter((relationship) => relationship.type === 'CALLS')
        .map((relationship) => ({
          source: result.graph.getNode(relationship.sourceId)?.properties.name,
          target: result.graph.getNode(relationship.targetId)?.properties.name,
        }));
      expect(calls.filter((call) => call.source === 'g').map((call) => call.target)).toEqual(['f']);

      const sourceFirstResult = await runPipelineFromRepo(repoDir, () => {}, {
        profile: 'symbols',
        includePaths: ['src/a.cxx', 'src/a.hxx'],
      });
      const sourceFirstMethods = [...sourceFirstResult.graph.iterNodes()].filter(
        (node) => node.label === 'Method' && node.properties.name === 'f',
      );
      expect(sourceFirstMethods).toHaveLength(1);
      expect(sourceFirstMethods[0].properties).toMatchObject({
        filePath: 'src/a.cxx',
        startLine: 1,
        endLine: 1,
        declarationFilePath: 'src/a.hxx',
        declarationStartLine: 0,
        declarationEndLine: 0,
        definitionFilePath: 'src/a.cxx',
        definitionStartLine: 1,
        definitionEndLine: 1,
      });
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('resolves declaration spans from macro-decorated C++ class declarations', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-cpp-macro-split-'));
    try {
      await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(repoDir, 'src/gridwin.hxx'),
        [
          '#define SAL_DLLPUBLIC_RTTI',
          'class SAL_DLLPUBLIC_RTTI ScGridWindow : public BaseWindow',
          '{',
          'public:',
          '    void PaintTile(int nCol);',
          '};',
          '',
        ].join('\n'),
        'utf8',
      );
      await fs.writeFile(
        path.join(repoDir, 'src/gridwin4.cxx'),
        [
          '#include "gridwin.hxx"',
          'void ScGridWindow::PaintTile(int nCol) {',
          '  (void)nCol;',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await runPipelineFromRepo(repoDir, () => {}, {
        profile: 'symbols',
        includePaths: ['src/gridwin4.cxx', 'src/gridwin.hxx'],
      });

      const method = [...result.graph.iterNodes()].find(
        (node) => node.label === 'Method' && node.properties.name === 'PaintTile',
      );
      const classes = [...result.graph.iterNodes()].filter((node) => node.label === 'Class');
      const gridClass = classes.find((node) => node.properties.name === 'ScGridWindow');
      expect(gridClass).toBeDefined();
      expect(classes.some((node) => node.properties.name === 'SAL_DLLPUBLIC_RTTI')).toBe(false);
      const paintTileFunctions = [...result.graph.iterNodes()].filter(
        (node) => node.label === 'Function' && node.properties.name === 'PaintTile',
      );
      expect(paintTileFunctions).toHaveLength(0);
      expect(method?.properties).toMatchObject({
        filePath: 'src/gridwin4.cxx',
        startLine: 1,
        declarationFilePath: 'src/gridwin.hxx',
        declarationStartLine: 4,
        declarationEndLine: 4,
        definitionFilePath: 'src/gridwin4.cxx',
        definitionStartLine: 1,
        definitionEndLine: 3,
      });
      expect([...result.graph.iterRelationships()]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceId: gridClass!.id,
            targetId: method!.id,
            type: 'HAS_METHOD',
          }),
        ]),
      );
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('normalizes macro-decorated C++ forward declarations to the real class name', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-cpp-macro-forward-'));
    try {
      await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(repoDir, 'src/chgtrack.hxx'),
        ['class SAL_DLLPUBLIC_RTTI ScChangeActionMove;', ''].join('\n'),
        'utf8',
      );

      const result = await runPipelineFromRepo(repoDir, () => {}, {
        profile: 'symbols',
        includePaths: ['src/chgtrack.hxx'],
      });

      const classes = [...result.graph.iterNodes()].filter((node) => node.label === 'Class');
      expect(classes.map((node) => node.properties.name)).toEqual(['ScChangeActionMove']);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('declines ambiguous split C++ owner hints instead of linking the wrong class', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-cpp-ambiguous-'));
    try {
      await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
      await fs.mkdir(path.join(repoDir, 'other'), { recursive: true });
      await fs.writeFile(
        path.join(repoDir, 'src/a.hxx'),
        ['namespace one { class A { public: int f(); }; }', ''].join('\n'),
        'utf8',
      );
      await fs.writeFile(
        path.join(repoDir, 'other/a.hxx'),
        ['namespace two { class A { public: int f(); }; }', ''].join('\n'),
        'utf8',
      );
      await fs.writeFile(
        path.join(repoDir, 'src/a.cxx'),
        ['int A::f(){ return 1; }', ''].join('\n'),
        'utf8',
      );

      const result = await runPipelineFromRepo(repoDir, () => {}, {
        profile: 'symbols',
        includePaths: ['src/a.hxx', 'other/a.hxx', 'src/a.cxx'],
      });
      const nodes = [...result.graph.iterNodes()];
      const sourceMethod = nodes.find(
        (node) =>
          node.label === 'Method' &&
          node.properties.name === 'f' &&
          node.properties.filePath === 'src/a.cxx',
      );
      expect(sourceMethod).toBeDefined();

      const relationships = [...result.graph.iterRelationships()];
      const classToSourceMethod = relationships.filter(
        (relationship) =>
          relationship.type === 'HAS_METHOD' && relationship.targetId === sourceMethod!.id,
      );
      expect(classToSourceMethod).toHaveLength(0);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('adds optional precision after parse only when explicitly configured', () => {
    const phaseNames = buildPhaseList({ optionalPrecisionAnalyzer: {} }).map((phase) => phase.name);

    expect(phaseNames.slice(0, 7)).toEqual([
      'scan',
      'gitMining',
      'structure',
      'markdown',
      'cobol',
      'parse',
      'optionalPrecision',
    ]);
    expect(phaseNames.indexOf('optionalPrecision')).toBeLessThan(phaseNames.indexOf('crossFile'));
  });

  it('returns a skipped optional precision timing record when configured but denied', async () => {
    const records: unknown[] = [];
    const options = {
      optionalPrecisionAnalyzer: {
        onTimingRecord: (record) => records.push(record),
      },
    };
    const phase = buildPhaseList(options).find(
      (candidate) => candidate.name === 'optionalPrecision',
    );

    expect(phase).toBeDefined();
    const output = (await phase!.execute(makeCtx(options), new Map())) as OptionalPrecisionOutput;

    expect(output).toMatchObject({
      decision: { allowed: false, reason: 'not-enabled' },
      timingRecord: {
        analyzerId: 'optional-precision-placeholder',
        status: 'skipped',
        skippedReason: 'not-enabled',
      },
    });
    expect(records).toHaveLength(1);
  });

  it('returns a completed placeholder timing record when policy scope is allowed', async () => {
    const records: unknown[] = [];
    const options = {
      optionalPrecisionAnalyzer: {
        policy: {
          enabled: true,
          allowedLanguages: ['typescript'],
          allowedPurposes: ['call-resolution' as const],
        },
        declaration: {
          engineId: 'tree-sitter-call-resolution',
          engineKind: 'tree-sitter-rule' as const,
          files: ['src/index.ts'],
          languages: ['typescript'],
          purposes: ['call-resolution'],
        },
        onTimingRecord: (record) => records.push(record),
      },
    };
    const phase = buildPhaseList(options).find(
      (candidate) => candidate.name === 'optionalPrecision',
    );

    expect(phase).toBeDefined();
    const output = (await phase!.execute(makeCtx(options), new Map())) as OptionalPrecisionOutput;

    expect(output).toMatchObject({
      decision: { allowed: true, reason: 'allowed' },
      timingRecord: {
        analyzerId: 'tree-sitter-call-resolution',
        status: 'completed',
        result: { outputCount: 0 },
      },
    });
    expect(records).toHaveLength(1);
  });
});

function makeCtx(options: PipelineContext['options']): PipelineContext {
  return {
    repoPath: '/tmp/ontoindex-test',
    graph: createKnowledgeGraph(),
    onProgress: () => {},
    options,
    pipelineStart: Date.now(),
  };
}
