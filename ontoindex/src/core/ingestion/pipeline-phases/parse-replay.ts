import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createKnowledgeGraph } from '../../graph/graph.js';
import type { GraphRelationship } from 'ontoindex-shared';
import type { KnowledgeGraph } from '../../graph/types.js';
import { BindingAccumulator } from '../binding-accumulator.js';
import { processCallsFromExtracted, seedCrossFileReceiverTypes } from '../call-processor.js';
import { processAssignmentsFromExtracted } from '../call-resolution/assignment-processor.js';
import { getHeritageStrategyForLanguage } from '../heritage-processor.js';
import { buildHeritageMap } from '../model/heritage-map.js';
import { createResolutionContext } from '../model/resolution-context.js';
import { prepareScopeCallPublication } from '../scope-call-publication.js';
import { isUnconsumedRustScopeFailure } from '../scope-extractor-bridge.js';
import { isRegistryPrimary } from '../registry-primary-flag.js';
import { restoreSemanticModelRegistrations } from '../model/semantic-model.js';
import type { runChunkedParseAndResolve } from './parse-impl.js';
import { getScanMaxFileSizeBytes, type ScannedFile } from '../filesystem-walker.js';
import { loadImportConfigs } from '../language-config.js';
import { workspaceParserIdentity } from '../../tree-sitter/parser-identity.js';
import type {
  loadScopeRetentionCandidate,
  ScopeRetentionCandidateFamilies,
} from './scope-retention-candidate-reader.js';
import {
  snapshotScopeRetentionDiscovery,
  scopeRetentionAnalysisPacksAbsent,
  type ScopeRetentionRequest,
} from './scope-retention-stage.js';
import { getLanguageFromFilename, SupportedLanguages } from 'ontoindex-shared';

function fail(reason: string): never {
  throw new Error(`scope-retention-parse-replay: ${reason}`);
}

/** Admit only complete retained parser inputs that still match this workspace. */
export async function admitScopeRetentionParseReplay(
  candidate: Awaited<ReturnType<typeof loadScopeRetentionCandidate>>,
  current: {
    repoPath: string;
    allPaths: readonly string[];
    scannedFiles: readonly ScannedFile[];
    skippedLargeFiles: readonly { path: string; size: number }[];
  },
  request: Pick<ScopeRetentionRequest, 'deadline' | 'signal'>,
): Promise<void> {
  if (!Number.isFinite(request.deadline)) fail('invalid request');
  const check = () => {
    if (request.signal?.aborted) fail('cancelled');
    if (Date.now() >= request.deadline) fail('deadline');
  };
  check();
  if (!(await scopeRetentionAnalysisPacksAbsent(current.repoPath, check)))
    fail('unsupported-analysis-packs');
  const { retention } = candidate.manifest;
  const evidence = retention.inputEvidence;
  const producers = [
    'parsed-files',
    'calls',
    'heritage',
    'assignments',
    'constructor-bindings',
    'exported-types',
    'file-bindings',
    'model-registrations',
    'import-states',
    'graph-nodes',
    'graph-relationships',
    'orm-queries',
    'fetch-calls',
    'routes',
    'decorator-routes',
    'tool-definitions',
  ] as const;
  if (
    retention.status !== 'retained' ||
    retention.reasons.length !== 0 ||
    !retention.graphNodesCaptured ||
    !retention.graphRelationshipsCaptured ||
    producers.some((name) => retention.producerCompletion[name] !== true)
  ) {
    fail('incomplete retained producers');
  }
  if (
    evidence.domain !== 'parser-text-utf8' ||
    !evidence.complete ||
    evidence.reasons.length !== 0 ||
    !evidence.configuration?.complete ||
    evidence.configuration.issues.length !== 0 ||
    evidence.parserCodeIdentity === null
  ) {
    fail('incomplete input evidence');
  }
  if (candidate.families.importStates.length !== 1) fail('expected exactly one import state');
  const paths = (values: readonly string[]): Set<string> => {
    const unique = new Set<string>();
    for (const value of values) {
      check();
      if (
        !value ||
        path.isAbsolute(value) ||
        path.win32.isAbsolute(value) ||
        /[\\\u0000-\u001f\u007f]/.test(value) ||
        value.split('/').some((part) => part === '' || part === '.' || part === '..')
      ) {
        fail('unsafe input path');
      }
      if (unique.has(value)) fail('duplicate input path');
      unique.add(value);
    }
    return unique;
  };
  const inventory = paths(retention.inventory.map((file) => file.filePath));
  const sources = paths(evidence.sources.map((file) => file.filePath));
  const parsed = paths(candidate.families.parsedFiles.map((file) => file.filePath));
  let discovery;
  try {
    discovery = snapshotScopeRetentionDiscovery(
      current.allPaths,
      current.scannedFiles,
      current.skippedLargeFiles,
      check,
    );
  } catch {
    check();
    fail('invalid current discovery');
  }
  if (!retention.discovery || !isDeepStrictEqual(discovery, retention.discovery))
    fail('discovery input mismatch');
  if (discovery.skipped.length) fail('skipped current files');
  const scannedLanguages = new Map(discovery.scanned.map((file) => [file.path, file.language]));
  const parserPaths = paths(
    discovery.allPaths.filter(
      (file) => (getLanguageFromFilename(file) ?? scannedLanguages.get(file)) != null,
    ),
  );
  if (
    retention.inventory.some(
      (file) =>
        file.status !== 'retained' &&
        !(file.status === 'not-required' && isUnconsumedRustScopeFailure(file)),
    )
  )
    fail('incomplete retained inventory');
  const requiredParsed = paths(
    retention.inventory.filter((file) => file.status === 'retained').map((file) => file.filePath),
  );
  if (
    parsed.size !== requiredParsed.size ||
    [...requiredParsed].some((file) => !parsed.has(file)) ||
    [sources, parserPaths].some(
      (set) => set.size !== inventory.size || [...inventory].some((file) => !set.has(file)),
    )
  ) {
    fail('input inventory mismatch');
  }
  const sameStat = (before: Stats, after: Stats) =>
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs;
  try {
    check();
    const beforeIdentity = await workspaceParserIdentity();
    check();
    if (!beforeIdentity || beforeIdentity !== evidence.parserCodeIdentity)
      fail('parser identity mismatch');
    // Replay stays bounded even when discovery's configurable size cap is disabled.
    const totalByteLimit = 64 * 1024 * 1024;
    const maxBytes = Math.min(getScanMaxFileSizeBytes() ?? totalByteLimit, totalByteLimit);
    let totalBytes = 0;
    for (const source of evidence.sources) {
      check();
      const segments = source.filePath.split('/');
      let directory = current.repoPath;
      for (const segment of segments.slice(0, -1)) {
        directory = path.join(directory, segment);
        const stat = await fs.lstat(directory);
        check();
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe source directory');
      }
      const filename = path.join(current.repoPath, source.filePath);
      const file = await fs.open(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        check();
        const before = await file.stat();
        check();
        if (
          !before.isFile() ||
          !Number.isSafeInteger(before.size) ||
          before.size < 0 ||
          before.size > maxBytes ||
          before.size > totalByteLimit - totalBytes
        ) {
          fail('invalid source or byte limit');
        }
        totalBytes += before.size;
        const chunks: Buffer[] = [];
        const buffer = Buffer.alloc(Math.min(64 * 1024, before.size + 1));
        let length = 0;
        while (true) {
          check();
          const { bytesRead } = await file.read(
            buffer,
            0,
            Math.min(buffer.length, before.size - length + 1),
            null,
          );
          check();
          if (!bytesRead) break;
          length += bytesRead;
          if (length > before.size) fail('source changed or byte limit');
          chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        const after = await file.stat();
        check();
        const named = await fs.lstat(filename);
        check();
        if (length !== before.size || !sameStat(before, after) || !sameStat(before, named)) {
          fail('source changed during read');
        }
        // Match fs.readFile(..., 'utf8') used by the parser, including replacement characters.
        const content = Buffer.concat(chunks, length).toString('utf8');
        if (
          Buffer.byteLength(content, 'utf8') !== source.byteLength ||
          createHash('sha256').update(content, 'utf8').digest('hex') !== source.sha256
        ) {
          fail('source input mismatch');
        }
      } finally {
        await file.close();
      }
      check();
    }
    const configuration = (await loadImportConfigs(current.repoPath, current.allPaths))
      .observations;
    check();
    if (
      !configuration.complete ||
      configuration.issues.length !== 0 ||
      !isDeepStrictEqual(configuration, evidence.configuration)
    )
      fail('configuration input mismatch');
    const afterIdentity = await workspaceParserIdentity();
    check();
    if (!afterIdentity || afterIdentity !== beforeIdentity) fail('parser identity changed');
    if (!(await scopeRetentionAnalysisPacksAbsent(current.repoPath, check)))
      fail('unsupported-analysis-packs');
  } catch (error) {
    check();
    if (error instanceof Error && error.message.startsWith('scope-retention-parse-replay: '))
      throw error;
    fail('current input verification unavailable');
  }
}

/** Rebuild parse-owned state from verified, loader-owned records.
 * Consumes the families: receiver seeding mutates calls and returned extraction arrays retain ownership.
 * The caller's graph is updated only after all reconstruction and resolution succeeds.
 */
export async function reconstructScopeRetentionParse(
  families: ScopeRetentionCandidateFamilies,
  graph: KnowledgeGraph,
  onProgress?: Parameters<typeof runChunkedParseAndResolve>[6],
): Promise<Awaited<ReturnType<typeof runChunkedParseAndResolve>>> {
  const scopeCallLanguages = new Set(
    [SupportedLanguages.TypeScript, SupportedLanguages.JavaScript].filter(isRegistryPrimary),
  );
  if (families.importStates.length !== 1) fail('expected exactly one import state');

  const staged = createKnowledgeGraph();
  for (const node of graph.iterNodes()) staged.addNode(structuredClone(node));
  for (const edge of graph.iterRelationships()) staged.addRelationship(structuredClone(edge));
  for (const node of families.declarationNodes) {
    const existing = staged.getNode(node.id);
    if (existing && !isDeepStrictEqual(existing, node)) fail(`conflicting graph node: ${node.id}`);
    staged.addNode(structuredClone(node));
  }
  for (const event of families.events) {
    // Registry lookup aliases need not match graph names; symbol.add names must.
    const definition = event.kind === 'symbol.add' ? event : 'def' in event ? event.def : undefined;
    if (!definition) continue;
    const node = staged.getNode(definition.nodeId);
    if (
      !node ||
      node.label !== definition.type ||
      (event.kind === 'symbol.add' && node.properties.name !== event.name) ||
      ![
        node.properties.filePath,
        node.properties.declarationFilePath,
        node.properties.definitionFilePath,
      ].includes(definition.filePath)
    ) {
      fail('registration does not match graph declaration');
    }
  }
  const hasReplayEndpoints = (edge: GraphRelationship): boolean => {
    if (!staged.getNode(edge.sourceId)) return false;
    if (staged.getNode(edge.targetId)) return true;
    // Legacy heritage keeps unresolved global IDs without creating parent nodes.
    return (
      (edge.type === 'EXTENDS' || edge.type === 'IMPLEMENTS') &&
      /^(?:Class|Interface|Trait):[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*(?![\s\S])/u.test(
        edge.targetId,
      )
    );
  };
  const edges = new Map(staged.relationships.map((edge) => [edge.id, edge]));
  for (const edge of families.structuralRelationships) {
    if (!hasReplayEndpoints(edge)) {
      fail(`dangling structural relationship: ${edge.id}`);
    }
    const existing = edges.get(edge.id);
    if (existing && !isDeepStrictEqual(existing, edge))
      fail(`conflicting relationship: ${edge.id}`);
    edges.set(edge.id, edge);
    staged.addRelationship(structuredClone(edge));
  }
  for (const records of [families.calls, families.assignments]) {
    for (const record of records) {
      if (!staged.getNode(record.sourceId)) fail(`missing source node: ${record.sourceId}`);
    }
  }

  const fileBindings = new Map<string, Map<string, string>>();
  const exportedTypeMap = new Map<string, Map<string, string>>();
  function addBinding(
    target: Map<string, Map<string, string>>,
    filePath: string,
    name: string,
    typeName: string,
  ) {
    let bindings = target.get(filePath);
    if (!bindings) target.set(filePath, (bindings = new Map()));
    if (bindings.has(name) && bindings.get(name) !== typeName)
      fail(`conflicting binding: ${filePath}:${name}`);
    bindings.set(name, typeName);
  }
  for (const { filePath, varName, typeName } of families.fileBindings) {
    addBinding(fileBindings, filePath, varName, typeName);
  }
  for (const { filePath, exportName, typeName } of families.exportedTypes) {
    addBinding(exportedTypeMap, filePath, exportName, typeName);
  }

  const model = restoreSemanticModelRegistrations({ version: 1, events: families.events });
  const bindingAccumulator = new BindingAccumulator();
  let resolutionContext: ReturnType<typeof createResolutionContext> | undefined;
  try {
    resolutionContext = createResolutionContext({ model, importState: families.importStates[0]! });
    resolutionContext.scopeCallPublication = prepareScopeCallPublication(
      families.parsedFiles,
      scopeCallLanguages,
    );
    resolutionContext.scopeCallPublication?.emit(staged);
    for (const [filePath, bindings] of fileBindings) {
      bindingAccumulator.appendFile(
        filePath,
        Array.from(bindings, ([varName, typeName]) => ({ scope: '', varName, typeName })),
      );
    }
    bindingAccumulator.finalize();
    const heritage = buildHeritageMap(
      families.heritage,
      resolutionContext,
      getHeritageStrategyForLanguage,
    );
    seedCrossFileReceiverTypes(families.calls, resolutionContext.namedImportMap, exportedTypeMap);
    await processCallsFromExtracted(
      staged,
      families.calls,
      resolutionContext,
      (current, total) =>
        onProgress?.({
          phase: 'parsing',
          percent: 90,
          message: 'Resolving retained calls...',
          detail: `${current}/${total} files`,
        }),
      families.constructors,
      heritage,
      bindingAccumulator,
    );
    processAssignmentsFromExtracted(
      staged,
      families.assignments,
      resolutionContext,
      families.constructors,
      bindingAccumulator,
    );
    for (const edge of staged.iterRelationships()) {
      if (!hasReplayEndpoints(edge)) fail(`dangling resolved relationship: ${edge.id}`);
    }
    for (const node of staged.iterNodes()) graph.addNode(node);
    for (const edge of staged.iterRelationships()) graph.addRelationship(edge);
    return {
      exportedTypeMap,
      allFetchCalls: families.fetchCalls,
      allExtractedRoutes: families.routes,
      allDecoratorRoutes: families.decoratorRoutes,
      allToolDefs: families.toolDefinitions,
      allORMQueries: families.ormQueries,
      bindingAccumulator,
      resolutionContext,
      usedWorkerPool: false,
    };
  } catch (error) {
    if (resolutionContext) resolutionContext.clear();
    else model.clear();
    bindingAccumulator.dispose();
    throw error;
  }
}
