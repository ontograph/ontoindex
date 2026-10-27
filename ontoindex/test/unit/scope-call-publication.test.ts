import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupportedLanguages, type ParsedFile, type ReferenceSite } from 'ontoindex-shared';
import { createParserForLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { getProviderForFile } from '../../src/core/ingestion/languages/index.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { prepareScopeCallPublication } from '../../src/core/ingestion/scope-call-publication.js';

async function fixture(source: string, path = 'calls.ts') {
  const provider = getProviderForFile(path)!;
  const parser = await createParserForLanguage(provider.id, path);
  const tree = parser.parse(source);
  const extracted = extractParsedFile(provider, source, path, undefined, tree.rootNode)!;
  expect(extracted).toBeDefined();
  const graph = createKnowledgeGraph();
  const definitionNodeIds = extracted.localDefs.map((def, index) => {
    const nodeId = `exact:${index}`;
    graph.addNode({
      id: nodeId,
      label: def.type,
      properties: { name: def.qualifiedName ?? '', filePath: path },
    });
    return { defId: def.nodeId, nodeId };
  });
  return { file: { ...extracted, definitionNodeIds } satisfies ParsedFile, graph };
}

function owns(
  publication: NonNullable<ReturnType<typeof prepareScopeCallPublication>>,
  file: ParsedFile,
  site: ReferenceSite,
) {
  return (
    site.selection === undefined &&
    publication.owns(file.filePath, site.name, site.atRange, site.callForm)
  );
}

describe('scope free-call publication ownership', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['calls.ts', 'calls.js'])(
    'emits exact mapped targets and owns module calls in %s',
    async (path) => {
      vi.stubEnv('REGISTRY_PRIMARY_TYPESCRIPT', '1');
      vi.stubEnv('REGISTRY_PRIMARY_JAVASCRIPT', '1');
      const { file, graph } = await fixture(
        'function target() {}\nfunction caller() { target(); }\ntarget();',
        path,
      );
      const publication = prepareScopeCallPublication([file])!;
      for (const site of file.referenceSites.filter((site) => site.kind === 'call'))
        expect(owns(publication, file, site)).toBe(true);
      publication.emit(graph);
      const id = (name: string) =>
        file.definitionNodeIds!.find(
          (mapping) =>
            mapping.defId === file.localDefs.find((def) => def.qualifiedName === name)!.nodeId,
        )!.nodeId;
      expect(graph.relationships).toEqual([
        expect.objectContaining({ sourceId: id('caller'), targetId: id('target'), type: 'CALLS' }),
      ]);
      const site = file.referenceSites.find((site) => site.kind === 'call')!;
      expect(publication.owns(path, site.name, undefined, 'free')).toBe(false);
      expect(
        publication.owns(
          path,
          site.name,
          { ...site.atRange, endCol: site.atRange.endCol + 1 },
          'free',
        ),
      ).toBe(false);
      expect(publication.owns(path, site.name, site.atRange, undefined)).toBe(false);
      expect(publication.owns('other.ts', site.name, site.atRange, 'free')).toBe(false);
      for (const range of [
        { ...site.atRange, startLine: 0 },
        { ...site.atRange, startCol: -0 },
        { ...site.atRange, endCol: Number.NaN },
        { ...site.atRange, endLine: site.atRange.startLine - 1 },
        { ...site.atRange, endLine: site.atRange.startLine, endCol: site.atRange.startCol },
      ])
        expect(publication.owns(path, site.name, range, 'free')).toBe(false);
    },
  );

  it.each([
    'function target() {} function caller(target) { target(); }',
    'function target() {} function caller() { const target = 1; target(); }',
    'function caller() { absent(); }',
    'function target(value) {} function caller() { target(); }',
  ])('retains unresolved ownership for %s', async (source) => {
    const { file, graph } = await fixture(source);
    const publication = prepareScopeCallPublication(
      [file],
      new Set([SupportedLanguages.TypeScript]),
    )!;
    const calls = file.referenceSites.filter((site) => site.kind === 'call');
    expect(calls).toHaveLength(1);
    expect(owns(publication, file, calls[0]!)).toBe(true);
    publication.emit(graph);
    expect(graph.relationships).toEqual([]);
  });

  it.each(['missing', 'conflicting', 'absent-node', 'wrong-kind', 'wrong-file'] as const)(
    'keeps ownership when exact mapping is %s',
    async (mode) => {
      const { file, graph } = await fixture('function target() {} function caller() { target(); }');
      let mappings = [...file.definitionNodeIds!];
      const target = mappings.find(
        (mapping) =>
          mapping.defId === file.localDefs.find((def) => def.qualifiedName === 'target')!.nodeId,
      )!;
      if (mode === 'missing') mappings = [];
      if (mode === 'conflicting') mappings.push({ ...target, nodeId: 'conflict' });
      if (mode === 'absent-node') graph.removeNode(target.nodeId);
      if (mode === 'wrong-kind' || mode === 'wrong-file') {
        graph.removeNode(target.nodeId);
        graph.addNode({
          id: target.nodeId,
          label: mode === 'wrong-kind' ? 'Class' : 'Function',
          properties: {
            name: 'target',
            filePath: mode === 'wrong-file' ? 'other.ts' : file.filePath,
          },
        });
      }
      const input = { ...file, definitionNodeIds: mappings };
      const publication = prepareScopeCallPublication(
        [input],
        new Set([SupportedLanguages.TypeScript]),
      )!;
      expect(owns(publication, file, file.referenceSites[0]!)).toBe(true);
      publication.emit(graph);
      expect(graph.relationships).toEqual([]);
    },
  );

  it('leaves imported names, members, constructors and reads to legacy', async () => {
    const { file, graph } = await fixture(
      "import { external } from './lib'; function caller() { external(); obj.run(); new Thing(); return caller; }",
    );
    const publication = prepareScopeCallPublication(
      [file],
      new Set([SupportedLanguages.TypeScript]),
    )!;
    expect(file.referenceSites.some((site) => site.name === 'external')).toBe(true);
    for (const site of file.referenceSites) expect(owns(publication, file, site)).toBe(false);
    publication.emit(graph);
    expect(graph.relationships).toEqual([]);
  });

  it('does not publish computed selections or their operands as calls', async () => {
    const { file, graph } = await fixture(
      'function table() {} function key() {} function caller() { table[key]; table["key"]; }',
    );
    expect(file.referenceSites.filter((site) => site.selection !== undefined)).toHaveLength(2);
    const publication = prepareScopeCallPublication(
      [file],
      new Set([SupportedLanguages.TypeScript]),
    )!;
    for (const site of file.referenceSites) expect(owns(publication, file, site)).toBe(false);
    publication.emit(graph);
    expect(graph.relationships).toEqual([]);
  });

  it('owns a local shadow of an unresolved import', async () => {
    const { file, graph } = await fixture(
      "import { external } from './lib'; function caller(external) { external(); }",
    );
    const publication = prepareScopeCallPublication(
      [file],
      new Set([SupportedLanguages.TypeScript]),
    )!;
    expect(owns(publication, file, file.referenceSites.find((site) => site.kind === 'call')!)).toBe(
      true,
    );
    publication.emit(graph);
    expect(graph.relationships).toEqual([]);
  });

  it('keeps ownership when only the caller mapping is missing', async () => {
    const { file, graph } = await fixture('function target() {} function caller() { target(); }');
    const caller = file.localDefs.find((def) => def.qualifiedName === 'caller')!;
    const input = {
      ...file,
      definitionNodeIds: file.definitionNodeIds!.filter(
        (mapping) => mapping.defId !== caller.nodeId,
      ),
    };
    const publication = prepareScopeCallPublication(
      [input],
      new Set([SupportedLanguages.TypeScript]),
    )!;
    expect(owns(publication, file, file.referenceSites[0]!)).toBe(true);
    publication.emit(graph);
    expect(graph.relationships).toEqual([]);
  });

  it('fails closed for duplicate site evidence with conflicting arity', async () => {
    const { file, graph } = await fixture('function target() {} function caller() { target(); }');
    const site = file.referenceSites[0]!;
    const publication = prepareScopeCallPublication(
      [{ ...file, referenceSites: [site, { ...site, arity: 2 }] }],
      new Set([SupportedLanguages.TypeScript]),
    )!;
    expect(owns(publication, file, site)).toBe(true);
    publication.emit(graph);
    expect(graph.relationships).toEqual([]);
  });

  it('leaves functions without fixed arity metadata to legacy', async () => {
    const { file: original } = await fixture(
      'function target() {} function caller() { target(); }',
    );
    const file = structuredClone(original);
    const target = file.localDefs.find((def) => def.qualifiedName === 'target')!;
    delete target.parameterCount;
    delete target.requiredParameterCount;
    const publication = prepareScopeCallPublication(
      [file],
      new Set([SupportedLanguages.TypeScript]),
    )!;
    expect(owns(publication, file, file.referenceSites[0]!)).toBe(false);
  });

  it('owns ambiguous local functions without choosing a target', async () => {
    const { file, graph } = await fixture('function target() {} function caller() { target(); }');
    const target = file.localDefs.find((def) => def.qualifiedName === 'target')!;
    const alternative = { ...target, nodeId: `${target.nodeId}:alternative` };
    const input: ParsedFile = {
      ...file,
      localDefs: [...file.localDefs, alternative],
      scopes: file.scopes.map((scope) => {
        const bucket = scope.bindings.get('target');
        if (!bucket?.some((binding) => binding.def.nodeId === target.nodeId)) return scope;
        const bindings = new Map(scope.bindings);
        bindings.set('target', [
          ...bucket,
          { origin: 'local', def: alternative, namespace: 'value' },
        ]);
        return { ...scope, bindings };
      }),
    };
    const publication = prepareScopeCallPublication(
      [input],
      new Set([SupportedLanguages.TypeScript]),
    )!;
    expect(owns(publication, file, file.referenceSites[0]!)).toBe(true);
    publication.emit(graph);
    expect(graph.relationships).toEqual([]);
  });

  it('separates a block shadow from a valid call in the same caller', async () => {
    const { file, graph } = await fixture(
      'function target() {} function caller() { { const target = 1; target(); } target(); }',
    );
    const publication = prepareScopeCallPublication(
      [file],
      new Set([SupportedLanguages.TypeScript]),
    )!;
    const sites = file.referenceSites.filter((site) => site.kind === 'call');
    expect(sites).toHaveLength(2);
    for (const site of sites) expect(owns(publication, file, site)).toBe(true);
    publication.emit(graph);
    expect(graph.relationships).toHaveLength(1);
    expect(graph.relationships[0]!.id).toContain(
      `:${sites[1]!.atRange.startLine}:${sites[1]!.atRange.startCol}`,
    );
  });

  it('returns no owner when flags are disabled and respects a frozen language set', async () => {
    const { file } = await fixture('function caller() { absent(); }');
    vi.stubEnv('REGISTRY_PRIMARY_TYPESCRIPT', '0');
    expect(prepareScopeCallPublication([file])).toBeUndefined();
    expect(prepareScopeCallPublication([])).toBeUndefined();
    expect(
      prepareScopeCallPublication([file], new Set([SupportedLanguages.TypeScript])),
    ).toBeDefined();
  });
});
