/**
 * CSV Generator for LadybugDB Hybrid Schema
 *
 * Streams CSV rows directly to disk files in a single pass over graph nodes.
 * File contents are lazy-read from disk per-node to avoid holding the entire
 * repo in RAM. Rows are buffered (FLUSH_EVERY) before writing to minimize
 * per-row Promise overhead.
 *
 * RFC 4180 Compliant:
 * - Fields containing commas, double quotes, or newlines are enclosed in double quotes
 * - Double quotes within fields are escaped by doubling them ("")
 * - All fields are consistently quoted for safety with code content
 */

import fs from 'fs/promises';
import path from 'path';
import type { GraphNode } from 'ontoindex-shared';
import { KnowledgeGraph } from '../graph/types.js';
import { NodeTableName } from './schema.js';
import {
  writeGraphBatch,
  isNativeGraphWriterEnabled,
  estimateNativeGraphRecordBytes,
  NATIVE_GRAPH_BATCH_BYTES,
} from '../../native/graph-writer.js';
import {
  createBufferedCsvRowWriter,
  MAX_BUFFERED_CHARACTERS,
  type CsvRowWriter,
  type CsvRowWriterFactory,
} from './csv-row-writer.js';
import { selectCsvRowWriterFactory } from '../../native/csv-writer.js';
import { sanitizeUTF8 } from './csv-sanitize.js';
import {
  EMPTY_STRING_ARRAY_LITERAL,
} from './string-array-properties.js';
export { sanitizeUTF8 } from './csv-sanitize.js';

// ============================================================================
// CSV ESCAPE UTILITIES
// ============================================================================

export const escapeCSVField = (value: string | number | undefined | null): string => {
  if (value === undefined || value === null) return '""';
  let str = String(value);
  str = sanitizeUTF8(str);
  return `"${str.replace(/"/g, '""')}"`;
};

export const escapeCSVNumber = (
  value: number | undefined | null,
  defaultValue: number = -1,
): string => {
  if (value === undefined || value === null) return String(defaultValue);
  return String(value);
};

const optionalStringProperty = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback;

const numericProperty = (value: unknown, fallback: number): number =>
  typeof value === 'number' ? value : fallback;

// ============================================================================
// CONTENT EXTRACTION (lazy — reads from disk on demand)
// ============================================================================

export const isBinaryContent = (content: string): boolean => {
  if (!content || content.length === 0) return false;
  const sample = content.slice(0, 1000);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32) || code === 127) nonPrintable++;
  }
  return nonPrintable / sample.length > 0.1;
};

const MAX_CACHED_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_CACHED_CHARS = 64 * 1024 * 1024;
export const MAX_SNIPPET_BOUNDARIES = 1_000_000;
const SOURCE_SCAN_BYTES = 64 * 1024;
const CONTENT_NODE_LABELS = new Set([
  'Function',
  'Class',
  'Interface',
  'CodeElement',
  'Method',
  'Section',
  'Const',
  'Struct',
  'Enum',
  'Macro',
  'Typedef',
  'Union',
  'Namespace',
  'Trait',
  'Impl',
  'TypeAlias',
  'Static',
  'Variable',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Module',
]);

type SourceStat = Awaited<ReturnType<typeof fs.stat>>;
interface SnippetSource {
  boundaries: Map<number, number>;
  remaining: number;
  stat?: SourceStat;
  lastLine?: number;
  binary?: boolean;
}

const sameSource = (left: SourceStat, right: SourceStat): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

/**
 * LRU content cache — avoids re-reading the same source file for every
 * symbol defined in it. Ordinary files are bounded by entry count and
 * MAX_CACHED_CHARS. Legacy whole-file requests above MAX_CACHED_FILE_BYTES are
 * not retained. Production symbol requests use only planned byte boundaries.
 */
export class FileContentCache {
  private cache = new Map<string, { content: string; lines?: string[] }>();
  private cachedChars = 0;
  private sources = new Map<string, SnippetSource>();
  private maxSize: number;
  private repoPath: string;

  constructor(repoPath: string, maxSize: number = 3000) {
    this.repoPath = repoPath;
    this.maxSize = maxSize;
  }

  async get(relativePath: string): Promise<string> {
    return (await this.getEntry(relativePath)).content;
  }

  /** Retained whole-file LRU characters; planned snippets retain no source text. */
  get retainedChars(): number {
    return this.cachedChars;
  }

  /** Two requested boundaries per symbol, with a hard ceiling before allocation. */
  planSnippets(nodes: Iterable<GraphNode>, allLabels = false): void {
    let boundaryCount = 0;
    for (const node of nodes) {
      if (
        (!allLabels && !CONTENT_NODE_LABELS.has(node.label)) ||
        node.label === 'File' ||
        node.label === 'Folder'
      )
        continue;
      const { filePath, startLine, endLine } = node.properties;
      if (!filePath || startLine === undefined || endLine === undefined) continue;
      if (
        !Number.isSafeInteger(startLine) ||
        !Number.isSafeInteger(endLine) ||
        startLine < 0 ||
        endLine < startLine ||
        !Number.isSafeInteger(endLine + 3)
      ) {
        throw new Error(`Invalid CSV snippet line range: ${filePath}`);
      }
      if (boundaryCount + 2 > MAX_SNIPPET_BOUNDARIES) {
        throw new Error(`CSV snippet boundary metadata exceeds ${MAX_SNIPPET_BOUNDARIES}`);
      }
      boundaryCount += 2;
      let source = this.sources.get(filePath);
      if (!source) {
        source = { boundaries: new Map(), remaining: 0 };
        this.sources.set(filePath, source);
      }
      source.remaining++;
      source.boundaries.set(Math.max(0, startLine - 2), 0);
      source.boundaries.set(endLine + 3, 0);
    }
  }

  async getSnippet(
    relativePath: string,
    startLine: number,
    endLine: number,
    cap: number,
  ): Promise<string> {
    if (!relativePath || cap === 0) return '';
    const source = this.sources.get(relativePath);
    if (!source) throw new Error(`Unplanned CSV snippet source: ${relativePath}`);
    const fullPath = path.join(this.repoPath, relativePath);
    let handle;
    try {
      handle = await fs.open(fullPath, 'r');
    } catch (error) {
      if (source.stat) throw new Error(`CSV source changed: ${relativePath}`, { cause: error });
      if (--source.remaining === 0) this.sources.delete(relativePath);
      return '';
    }
    try {
      const before = await handle.stat();
      const assertUnchanged = async (): Promise<void> => {
        const after = await handle.stat();
        const current = await fs.stat(fullPath);
        if (
          !sameSource(before, after) ||
          !sameSource(before, current) ||
          (source.stat && !sameSource(source.stat, before))
        ) {
          throw new Error(`CSV source changed: ${relativePath}`);
        }
      };
      if (!source.stat) {
        const buffer = Buffer.alloc(SOURCE_SCAN_BYTES);
        const sample = Buffer.alloc(3 * 1000 + 4);
        let sampleBytes = 0;
        let position = 0;
        let line = 0;
        for (const boundary of source.boundaries.keys())
          source.boundaries.set(boundary, before.size);
        if (source.boundaries.has(0)) source.boundaries.set(0, 0);
        while (position < before.size) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, before.size - position),
            position,
          );
          if (bytesRead === 0) throw new Error(`CSV source changed: ${relativePath}`);
          const copied = Math.min(bytesRead, sample.length - sampleBytes);
          buffer.copy(sample, sampleBytes, 0, copied);
          sampleBytes += copied;
          let index = buffer.indexOf(10, 0);
          while (index >= 0 && index < bytesRead) {
            line++;
            if (source.boundaries.has(line)) source.boundaries.set(line, position + index + 1);
            index = buffer.indexOf(10, index + 1);
          }
          position += bytesRead;
        }
        await assertUnchanged();
        source.stat = before;
        source.lastLine = line;
        source.binary = isBinaryContent(sample.subarray(0, sampleBytes).toString('utf8'));
      }
      await assertUnchanged();
      let snippet = '';
      if (source.binary) {
        snippet = '[Binary file - content not stored]';
      } else {
        const start = Math.max(0, startLine - 2);
        const end = endLine + 3;
        const from = source.boundaries.get(start)!;
        // A non-EOF boundary points past the LF separating the next excluded line.
        const to = source.boundaries.get(end)! - (end <= source.lastLine! ? 1 : 0);
        if (start <= source.lastLine! && to > from) {
          const length = Math.min(to - from, 3 * (cap + 1) + 4);
          const buffer = Buffer.alloc(length);
          let read = 0;
          while (read < length) {
            const { bytesRead } = await handle.read(buffer, read, length - read, from + read);
            if (bytesRead === 0) throw new Error(`CSV source changed: ${relativePath}`);
            read += bytesRead;
          }
          snippet = buffer.toString('utf8');
          if (snippet.length > cap) snippet = snippet.slice(0, cap) + '\n... [truncated]';
        }
      }
      await assertUnchanged();
      return snippet;
    } finally {
      await handle.close();
      if (--source.remaining === 0) this.sources.delete(relativePath);
    }
  }

  async getPrefix(relativePath: string, maxChars: number): Promise<string> {
    if (!relativePath) return '';
    const cached = this.getCachedEntry(relativePath);
    if (cached) return cached.content;
    const fullPath = path.join(this.repoPath, relativePath);
    const prefixBytes = 3 * Math.max(maxChars, 1000) + 4;
    try {
      const stat = await fs.stat(fullPath);
      if (stat.size <= prefixBytes) return this.get(relativePath);
      const handle = await fs.open(fullPath, 'r');
      try {
        const buffer = Buffer.alloc(prefixBytes);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (result.bytesRead === 0) break;
          bytesRead += result.bytesRead;
        }
        // Preserve a leading BOM just as readFile('utf-8') does.
        const content = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
          buffer.subarray(0, bytesRead),
        );
        // Keep enough text for binary detection, which samples the first 1000 units.
        const end = Math.min(content.length, Math.max(maxChars + 1, 1000));
        const lastCode = content.charCodeAt(end - 1);
        if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
          // Keep the overflow unit visible to truncation without returning a lone surrogate.
          return content.slice(0, end - 1) + '\ufffd';
        }
        return content.slice(0, end);
      } finally {
        await handle.close();
      }
    } catch {
      return '';
    }
  }

  async getLines(relativePath: string): Promise<string[]> {
    const entry = await this.getEntry(relativePath);
    if (!entry.content) return [];
    if (!entry.lines) entry.lines = entry.content.split('\n');
    return entry.lines;
  }

  private getCachedEntry(relativePath: string): { content: string; lines?: string[] } | undefined {
    const cached = this.cache.get(relativePath);
    if (cached !== undefined) {
      this.cache.delete(relativePath);
      this.cache.set(relativePath, cached);
      return cached;
    }
    return undefined;
  }

  private async getEntry(relativePath: string): Promise<{ content: string; lines?: string[] }> {
    if (!relativePath) return { content: '' };
    const cached = this.getCachedEntry(relativePath);
    if (cached) return cached;
    try {
      const fullPath = path.join(this.repoPath, relativePath);
      const stat = await fs.stat(fullPath);
      const content = await fs.readFile(fullPath, 'utf-8');
      if (stat.size > MAX_CACHED_FILE_BYTES) {
        return { content };
      }
      return this.set(relativePath, content);
    } catch {
      return this.set(relativePath, '');
    }
  }

  private set(key: string, content: string): { content: string; lines?: string[] } {
    while (
      this.cache.size >= this.maxSize ||
      this.cachedChars + content.length > MAX_CACHED_CHARS
    ) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cachedChars -= this.cache.get(oldest)!.content.length;
      this.cache.delete(oldest);
    }
    const entry = { content };
    this.cache.set(key, entry);
    this.cachedChars += content.length;
    return entry;
  }
}

const envInt = (name: string): number | undefined => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

interface ContentLimits {
  maxSnippetChars: number;
  maxFileContentChars: number;
}

// An escaped capped file is at most 2x plus the marker, so its row fits one writer batch.
const DEFAULT_MAX_FILE_CONTENT_CHARS = MAX_BUFFERED_CHARACTERS / 4;

const extractContent = async (
  node: GraphNode,
  contentCache: FileContentCache,
  limits: ContentLimits,
): Promise<string> => {
  const filePath = node.properties.filePath;
  if (node.label === 'Folder') return '';
  if (node.label !== 'File' && limits.maxSnippetChars === 0) return '';
  if (node.label !== 'File') {
    const { startLine, endLine } = node.properties;
    if (startLine === undefined || endLine === undefined) return '';
    return contentCache.getSnippet(filePath, startLine, endLine, limits.maxSnippetChars);
  }
  const content =
    node.label === 'File' && limits.maxFileContentChars > 0
      ? await contentCache.getPrefix(filePath, limits.maxFileContentChars)
      : await contentCache.get(filePath);
  if (!content) return '';
  if (isBinaryContent(content)) return '[Binary file - content not stored]';

  if (node.label === 'File') {
    const cap = limits.maxFileContentChars;
    if (cap > 0 && content.length > cap) {
      const lastCode = content.charCodeAt(cap - 1);
      const end = lastCode >= 0xd800 && lastCode <= 0xdbff ? cap - 1 : cap;
      return content.slice(0, end) + '\n... [File content truncated]';
    }
    return content;
  }

  return content;
};

// ============================================================================
// STREAMING CSV GENERATION — SINGLE PASS
// ============================================================================

interface StreamedCSVResult {
  nodeFiles: Map<NodeTableName, { csvPath: string; rows: number }>;
  relCsvPath: string;
  relRows: number;
  relByPairMeta?: Map<string, number>;
}

interface StreamAllCSVsOptions {
  createWriter?: CsvRowWriterFactory;
}

const writeCsvRow = (writer: CsvRowWriter, row: string): void | Promise<void> => writer.addRow(row);

/**
 * Stream all CSV data directly to disk files.
 * Iterates graph nodes exactly ONCE — routes each node to the right writer.
 * File contents are lazy-read from disk with a generous LRU cache.
 * List columns contain empty placeholders; only loadGraphToLbug restores them
 * from the source graph with prepared STRING[] parameters before using the data.
 */
export const streamAllCSVsToDisk = async (
  graph: KnowledgeGraph,
  repoPath: string,
  csvDir: string,
  options: StreamAllCSVsOptions = {},
): Promise<StreamedCSVResult> => {
  // Remove stale CSVs from previous crashed runs, then recreate
  try {
    await fs.rm(csvDir, { recursive: true, force: true });
  } catch {}
  await fs.mkdir(csvDir, { recursive: true });

  const contentCache = new FileContentCache(repoPath);
  const largeGraph = graph.nodeCount > 25_000;
  const contentLimits: ContentLimits = {
    maxSnippetChars: envInt('ONTOINDEX_MAX_SNIPPET_CHARS') ?? (largeGraph ? 1_000 : 5_000),
    maxFileContentChars:
      envInt('ONTOINDEX_MAX_FILE_CONTENT_CHARS') ?? DEFAULT_MAX_FILE_CONTENT_CHARS,
  };

  const nativeGraphWriter = isNativeGraphWriterEnabled();
  if (contentLimits.maxSnippetChars > 0) {
    contentCache.planSnippets(graph.iterNodes(), nativeGraphWriter);
  }

  const seenNodeIds = new Set<string>();

  if (nativeGraphWriter) {
    const BATCH_SIZE = 1000;
    let nodeBatch: GraphNode[] = [];
    let relBatch: any[] = [];
    let nodeBytes = 0;
    let relBytes = 0;
    let totalRels = 0;

    const nodeRowCounts = new Map<string, number>();
    const relRowCounts = new Map<string, number>();

    // 1. Process all nodes in batches
    for (const node of graph.iterNodes()) {
      if (seenNodeIds.has(node.id)) continue;
      seenNodeIds.add(node.id);

      // Extract content (must still happen in TS for now due to complex logic/LRU)
      const content = await extractContent(node, contentCache, contentLimits);
      const nodeToSerialize = { ...node, properties: { ...node.properties, content } };
      const bytes = estimateNativeGraphRecordBytes(nodeToSerialize);
      if (nodeBatch.length && nodeBytes + bytes > NATIVE_GRAPH_BATCH_BYTES) {
        const { nodeCounts } = await writeGraphBatch(csvDir, nodeBatch, []);
        for (const [label, count] of nodeCounts) {
          nodeRowCounts.set(label, (nodeRowCounts.get(label) || 0) + count);
        }
        nodeBatch = [];
        nodeBytes = 0;
      }
      // One oversized source object is the explicit residual beyond the byte budget.
      nodeBatch.push(nodeToSerialize);
      nodeBytes += bytes;

      if (nodeBatch.length >= BATCH_SIZE || nodeBytes >= NATIVE_GRAPH_BATCH_BYTES) {
        const { nodeCounts } = await writeGraphBatch(csvDir, nodeBatch, []);
        for (const [label, count] of nodeCounts) {
          nodeRowCounts.set(label, (nodeRowCounts.get(label) || 0) + count);
        }
        nodeBatch = [];
        nodeBytes = 0;
      }
    }
    if (nodeBatch.length > 0) {
      const { nodeCounts } = await writeGraphBatch(csvDir, nodeBatch, []);
      for (const [label, count] of nodeCounts) {
        nodeRowCounts.set(label, (nodeRowCounts.get(label) || 0) + count);
      }
    }

    // 2. Process all relationships in batches
    for (const rel of graph.iterRelationships()) {
      const bytes = estimateNativeGraphRecordBytes(rel);
      if (relBatch.length && relBytes + bytes > NATIVE_GRAPH_BATCH_BYTES) {
        const { relCounts } = await writeGraphBatch(csvDir, [], relBatch);
        for (const [pair, count] of relCounts) {
          relRowCounts.set(pair, (relRowCounts.get(pair) || 0) + count);
        }
        relBatch = [];
        relBytes = 0;
      }
      relBatch.push(rel);
      relBytes += bytes;
      totalRels++;
      if (relBatch.length >= BATCH_SIZE || relBytes >= NATIVE_GRAPH_BATCH_BYTES) {
        const { relCounts } = await writeGraphBatch(csvDir, [], relBatch);
        for (const [pair, count] of relCounts) {
          relRowCounts.set(pair, (relRowCounts.get(pair) || 0) + count);
        }
        relBatch = [];
        relBytes = 0;
      }
    }
    if (relBatch.length > 0) {
      const { relCounts } = await writeGraphBatch(csvDir, [], relBatch);
      for (const [pair, count] of relCounts) {
        relRowCounts.set(pair, (relRowCounts.get(pair) || 0) + count);
      }
    }

    // Return result mapping based on files created on disk
    const nodeFiles = new Map<NodeTableName, { csvPath: string; rows: number }>();
    const files = await fs.readdir(csvDir);
    for (const file of files) {
      if (file.startsWith('nodes_') && file.endsWith('.csv')) {
        const label = file.replace('nodes_', '').replace('.csv', '');
        const csvPath = path.join(csvDir, file);
        nodeFiles.set(label as NodeTableName, {
          csvPath,
          rows: nodeRowCounts.get(label) || 0,
        });
      }
    }

    return {
      nodeFiles,
      relCsvPath: '',
      relRows: totalRels,
      relByPairMeta: relRowCounts,
    };
  }

  // We open ~30 concurrent write-streams; raise process limit to suppress
  // MaxListenersExceededWarning (restored after all streams finish).
  const prevMax = process.getMaxListeners();
  process.setMaxListeners(prevMax + 40);
  const writers: CsvRowWriter[] = [];
  try {
    const factory =
      options.createWriter ??
      (await selectCsvRowWriterFactory({
        fallbackFactory: createBufferedCsvRowWriter,
        onWarning: (message) => console.warn(message),
      }));
    const createWriter: CsvRowWriterFactory = (csvPath, header) => {
      const writer = factory(csvPath, header);
      writers.push(writer);
      return writer;
    };

    // Create writers for every node type up-front
    const fileWriter = createWriter(path.join(csvDir, 'file.csv'), 'id,name,filePath,content');
    const folderWriter = createWriter(path.join(csvDir, 'folder.csv'), 'id,name,filePath');
    const codeElementHeader = 'id,name,filePath,startLine,endLine,isExported,content,description';
    const functionWriter = createWriter(path.join(csvDir, 'function.csv'), codeElementHeader);
    const classWriter = createWriter(path.join(csvDir, 'class.csv'), codeElementHeader);
    const interfaceWriter = createWriter(path.join(csvDir, 'interface.csv'), codeElementHeader);
    const methodHeader =
      'id,name,filePath,startLine,endLine,isExported,content,description,parameterCount,returnType,declarationFilePath,declarationStartLine,declarationEndLine,definitionFilePath,definitionStartLine,definitionEndLine';
    const methodWriter = createWriter(path.join(csvDir, 'method.csv'), methodHeader);
    const codeElemWriter = createWriter(path.join(csvDir, 'codeelement.csv'), codeElementHeader);
    const communityWriter = createWriter(
      path.join(csvDir, 'community.csv'),
      'id,label,heuristicLabel,keywords,description,enrichedBy,cohesion,symbolCount',
    );
    const processWriter = createWriter(
      path.join(csvDir, 'process.csv'),
      'id,label,heuristicLabel,processType,stepCount,communities,entryPointId,terminalId',
    );
    const summaryNodeWriter = createWriter(
      path.join(csvDir, 'summarynode.csv'),
      'id,name,filePath,level,summaryKind,summarizedCommunityIds,summarizedConceptIds,summarizedNodeIds,truncated,depth,description,communityLabel,heuristicLabel,cohesion,symbolCount,memberCount,includedMemberCount,membersTruncated,conceptCount,includedConceptCount,conceptsTruncated,groundingCount,includedGroundingCount,groundingsTruncated,sourceDocuments,sourceFactKeys,resolutionKeys,authority,evidenceClass,freshness,confidence,omittedCommunityCount',
    );
    const conceptWriter = createWriter(
      path.join(csvDir, 'concept.csv'),
      'id,name,filePath,aliases,sourceDocuments,sourceFactKeys,resolutionKeys,authority,confidence,evidenceClass,freshness',
    );

    // Section nodes have an extra 'level' column
    const sectionWriter = createWriter(
      path.join(csvDir, 'section.csv'),
      'id,name,filePath,startLine,endLine,level,content,description',
    );

    // Route nodes for API endpoint mapping
    const routeWriter = createWriter(
      path.join(csvDir, 'route.csv'),
      'id,name,filePath,responseKeys,errorKeys,middleware',
    );

    // Tool nodes for MCP tool definitions
    const toolWriter = createWriter(path.join(csvDir, 'tool.csv'), 'id,name,filePath,description');

    // Const gets a dedicated writer with isExported column
    const constWriter = createWriter(
      path.join(csvDir, 'const.csv'),
      'id,name,filePath,startLine,endLine,isExported,content,description',
    );

    // Multi-language node types share the same CSV shape (no isExported column)
    const multiLangHeader = 'id,name,filePath,startLine,endLine,content,description';
    const MULTI_LANG_TYPES = [
      'Struct',
      'Enum',
      'Macro',
      'Typedef',
      'Union',
      'Namespace',
      'Trait',
      'Impl',
      'TypeAlias',
      'Static',
      'Variable',
      'Property',
      'Record',
      'Delegate',
      'Annotation',
      'Constructor',
      'Template',
      'Module',
    ] as const;
    const multiLangWriters = new Map<string, CsvRowWriter>();
    for (const t of MULTI_LANG_TYPES) {
      multiLangWriters.set(
        t,
        createWriter(path.join(csvDir, `${t.toLowerCase()}.csv`), multiLangHeader),
      );
    }

    const codeWriterMap: Record<string, CsvRowWriter> = {
      Function: functionWriter,
      Class: classWriter,
      Interface: interfaceWriter,
      CodeElement: codeElemWriter,
    };

    // Restore original process listener limit
    process.setMaxListeners(prevMax);

    // --- SINGLE PASS over all nodes (EXISTING TS PATH) ---
    for (const node of graph.iterNodes()) {
      if (seenNodeIds.has(node.id)) continue;
      seenNodeIds.add(node.id);
      let pendingWrite: void | Promise<void>;

      switch (node.label) {
        case 'File': {
          const content = await extractContent(node, contentCache, contentLimits);
          pendingWrite = writeCsvRow(
            fileWriter,
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVField(content),
            ].join(','),
          );
          if (pendingWrite) await pendingWrite;
          break;
        }
        case 'Folder':
          pendingWrite = writeCsvRow(
            folderWriter,
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
            ].join(','),
          );
          if (pendingWrite) await pendingWrite;
          break;
        case 'Community': {
          pendingWrite = writeCsvRow(
            communityWriter,
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.heuristicLabel || ''),
              EMPTY_STRING_ARRAY_LITERAL,
              escapeCSVField(node.properties.description || ''),
              escapeCSVField(node.properties.enrichedBy || 'heuristic'),
              escapeCSVNumber(node.properties.cohesion, 0),
              escapeCSVNumber(node.properties.symbolCount, 0),
            ].join(','),
          );
          if (pendingWrite) await pendingWrite;
          break;
        }
        case 'Process': {
          pendingWrite = writeCsvRow(
            processWriter,
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.heuristicLabel || ''),
              escapeCSVField(node.properties.processType || ''),
              escapeCSVNumber(node.properties.stepCount, 0),
              escapeCSVField(EMPTY_STRING_ARRAY_LITERAL),
              escapeCSVField(node.properties.entryPointId || ''),
              escapeCSVField(node.properties.terminalId || ''),
            ].join(','),
          );
          if (pendingWrite) await pendingWrite;
          break;
        }
        case 'SummaryNode': {
          const summaryKind = optionalStringProperty(node.properties.summaryKind, '');
          const communityLabel = optionalStringProperty(node.properties.communityLabel, '');
          const heuristicLabel = optionalStringProperty(node.properties.heuristicLabel, '');
          const depth = numericProperty(node.properties.depth, 0);
          const cohesion = numericProperty(node.properties.cohesion, 0);
          const symbolCount = numericProperty(node.properties.symbolCount, 0);
          const memberCount = numericProperty(node.properties.memberCount, 0);
          const includedMemberCount = numericProperty(node.properties.includedMemberCount, 0);
          const conceptCount = numericProperty(node.properties.conceptCount, 0);
          const includedConceptCount = numericProperty(node.properties.includedConceptCount, 0);
          const groundingCount = numericProperty(node.properties.groundingCount, 0);
          const includedGroundingCount = numericProperty(node.properties.includedGroundingCount, 0);
          const omittedCommunityCount = numericProperty(node.properties.omittedCommunityCount, 0);
          pendingWrite = writeCsvRow(
            summaryNodeWriter,
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVNumber(node.properties.level, 0),
              escapeCSVField(summaryKind),
              escapeCSVField(EMPTY_STRING_ARRAY_LITERAL),
              escapeCSVField(EMPTY_STRING_ARRAY_LITERAL),
              escapeCSVField(EMPTY_STRING_ARRAY_LITERAL),
              node.properties.truncated ? 'true' : 'false',
              escapeCSVNumber(depth, 0),
              escapeCSVField(node.properties.description || ''),
              escapeCSVField(communityLabel),
              escapeCSVField(heuristicLabel),
              escapeCSVNumber(cohesion, 0),
              escapeCSVNumber(symbolCount, 0),
              escapeCSVNumber(memberCount, 0),
              escapeCSVNumber(includedMemberCount, 0),
              node.properties.membersTruncated ? 'true' : 'false',
              escapeCSVNumber(conceptCount, 0),
              escapeCSVNumber(includedConceptCount, 0),
              node.properties.conceptsTruncated ? 'true' : 'false',
              escapeCSVNumber(groundingCount, 0),
              escapeCSVNumber(includedGroundingCount, 0),
              node.properties.groundingsTruncated ? 'true' : 'false',
              escapeCSVField(EMPTY_STRING_ARRAY_LITERAL),
              escapeCSVField(EMPTY_STRING_ARRAY_LITERAL),
              escapeCSVField(EMPTY_STRING_ARRAY_LITERAL),
              escapeCSVField(optionalStringProperty(node.properties.authority, '')),
              escapeCSVField(optionalStringProperty(node.properties.evidenceClass, '')),
              escapeCSVField(optionalStringProperty(node.properties.freshness, '')),
              escapeCSVField(optionalStringProperty(node.properties.confidence, '')),
              escapeCSVNumber(omittedCommunityCount, 0),
            ].join(','),
          );
          if (pendingWrite) await pendingWrite;
          break;
        }
        case 'Concept': {
          pendingWrite = writeCsvRow(
            conceptWriter,
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVField(EMPTY_STRING_ARRAY_LITERAL),
              escapeCSVField(EMPTY_STRING_ARRAY_LITERAL),
              escapeCSVField(EMPTY_STRING_ARRAY_LITERAL),
              escapeCSVField(EMPTY_STRING_ARRAY_LITERAL),
              escapeCSVField(optionalStringProperty(node.properties.authority, 'advisory')),
              escapeCSVField(optionalStringProperty(node.properties.confidence, 'low')),
              escapeCSVField(
                optionalStringProperty(node.properties.evidenceClass, 'docs_evidence'),
              ),
              escapeCSVField(optionalStringProperty(node.properties.freshness, 'unknown')),
            ].join(','),
          );
          if (pendingWrite) await pendingWrite;
          break;
        }
        case 'Method': {
          const content = await extractContent(node, contentCache, contentLimits);
          pendingWrite = writeCsvRow(
            methodWriter,
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVNumber(node.properties.startLine, -1),
              escapeCSVNumber(node.properties.endLine, -1),
              node.properties.isExported ? 'true' : 'false',
              escapeCSVField(content),
              escapeCSVField(node.properties.description || ''),
              escapeCSVNumber(node.properties.parameterCount, 0),
              escapeCSVField(node.properties.returnType || ''),
              escapeCSVField(
                typeof node.properties.declarationFilePath === 'string'
                  ? node.properties.declarationFilePath
                  : '',
              ),
              escapeCSVNumber(
                typeof node.properties.declarationStartLine === 'number'
                  ? node.properties.declarationStartLine
                  : undefined,
                -1,
              ),
              escapeCSVNumber(
                typeof node.properties.declarationEndLine === 'number'
                  ? node.properties.declarationEndLine
                  : undefined,
                -1,
              ),
              escapeCSVField(
                typeof node.properties.definitionFilePath === 'string'
                  ? node.properties.definitionFilePath
                  : '',
              ),
              escapeCSVNumber(
                typeof node.properties.definitionStartLine === 'number'
                  ? node.properties.definitionStartLine
                  : undefined,
                -1,
              ),
              escapeCSVNumber(
                typeof node.properties.definitionEndLine === 'number'
                  ? node.properties.definitionEndLine
                  : undefined,
                -1,
              ),
            ].join(','),
          );
          if (pendingWrite) await pendingWrite;
          break;
        }
        case 'Section': {
          const content = await extractContent(node, contentCache, contentLimits);
          pendingWrite = writeCsvRow(
            sectionWriter,
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVNumber(node.properties.startLine, -1),
              escapeCSVNumber(node.properties.endLine, -1),
              escapeCSVNumber(node.properties.level, 1),
              escapeCSVField(content),
              escapeCSVField(node.properties.description || ''),
            ].join(','),
          );
          if (pendingWrite) await pendingWrite;
          break;
        }
        case 'Route': {
          pendingWrite = writeCsvRow(
            routeWriter,
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVField(EMPTY_STRING_ARRAY_LITERAL),
              escapeCSVField(EMPTY_STRING_ARRAY_LITERAL),
              escapeCSVField(EMPTY_STRING_ARRAY_LITERAL),
            ].join(','),
          );
          if (pendingWrite) await pendingWrite;
          break;
        }
        case 'Tool':
          pendingWrite = writeCsvRow(
            toolWriter,
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVField(node.properties.description || ''),
            ].join(','),
          );
          if (pendingWrite) await pendingWrite;
          break;
        case 'Const': {
          const content = await extractContent(node, contentCache, contentLimits);
          pendingWrite = writeCsvRow(
            constWriter,
            [
              escapeCSVField(node.id),
              escapeCSVField(node.properties.name || ''),
              escapeCSVField(node.properties.filePath || ''),
              escapeCSVNumber(node.properties.startLine, -1),
              escapeCSVNumber(node.properties.endLine, -1),
              node.properties.isExported ? 'true' : 'false',
              escapeCSVField(content),
              escapeCSVField(node.properties.description || ''),
            ].join(','),
          );
          if (pendingWrite) await pendingWrite;
          break;
        }
        default: {
          // Code element nodes (Function, Class, Interface, CodeElement)
          const writer = codeWriterMap[node.label];
          if (writer) {
            const content = await extractContent(node, contentCache, contentLimits);
            pendingWrite = writeCsvRow(
              writer,
              [
                escapeCSVField(node.id),
                escapeCSVField(node.properties.name || ''),
                escapeCSVField(node.properties.filePath || ''),
                escapeCSVNumber(node.properties.startLine, -1),
                escapeCSVNumber(node.properties.endLine, -1),
                node.properties.isExported ? 'true' : 'false',
                escapeCSVField(content),
                escapeCSVField(node.properties.description || ''),
              ].join(','),
            );
            if (pendingWrite) await pendingWrite;
          } else {
            // Multi-language node types (Struct, Impl, Trait, Macro, etc.)
            const mlWriter = multiLangWriters.get(node.label);
            if (mlWriter) {
              const content = await extractContent(node, contentCache, contentLimits);
              pendingWrite = writeCsvRow(
                mlWriter,
                [
                  escapeCSVField(node.id),
                  escapeCSVField(node.properties.name || ''),
                  escapeCSVField(node.properties.filePath || ''),
                  escapeCSVNumber(node.properties.startLine, -1),
                  escapeCSVNumber(node.properties.endLine, -1),
                  escapeCSVField(content),
                  escapeCSVField(node.properties.description || ''),
                ].join(','),
              );
              if (pendingWrite) await pendingWrite;
            }
          }
          break;
        }
      }
    }

    // Finish all node writers
    const allWriters = [
      fileWriter,
      folderWriter,
      functionWriter,
      classWriter,
      interfaceWriter,
      methodWriter,
      codeElemWriter,
      communityWriter,
      processWriter,
      summaryNodeWriter,
      conceptWriter,
      sectionWriter,
      routeWriter,
      toolWriter,
      constWriter,
      ...multiLangWriters.values(),
    ];
    await Promise.all(allWriters.map((w) => w.finish()));

    // --- Stream relationship CSV ---
    const relCsvPath = path.join(csvDir, 'relations.csv');
    const relWriter = createWriter(relCsvPath, 'from,to,type,confidence,reason,step');
    for (const rel of graph.iterRelationships()) {
      const pendingWrite = writeCsvRow(
        relWriter,
        [
          escapeCSVField(rel.sourceId),
          escapeCSVField(rel.targetId),
          escapeCSVField(rel.type),
          escapeCSVNumber(rel.confidence, 1.0),
          escapeCSVField(rel.reason),
          escapeCSVNumber(rel.step, 0),
        ].join(','),
      );
      if (pendingWrite) await pendingWrite;
    }
    await relWriter.finish();

    // Build result map — only include tables that have rows
    const nodeFiles = new Map<NodeTableName, { csvPath: string; rows: number }>();
    const tableMap: [NodeTableName, CsvRowWriter][] = [
      ['File', fileWriter],
      ['Folder', folderWriter],
      ['Function', functionWriter],
      ['Class', classWriter],
      ['Interface', interfaceWriter],
      ['Method', methodWriter],
      ['CodeElement', codeElemWriter],
      ['Community', communityWriter],
      ['Process', processWriter],
      ['SummaryNode' as NodeTableName, summaryNodeWriter],
      ['Concept', conceptWriter],
      ['Section' as NodeTableName, sectionWriter],
      ['Route' as NodeTableName, routeWriter],
      ['Tool' as NodeTableName, toolWriter],
      ['Const' as NodeTableName, constWriter],
      ...Array.from(multiLangWriters.entries()).map(
        ([name, w]) => [name as NodeTableName, w] as [NodeTableName, CsvRowWriter],
      ),
    ];
    for (const [name, writer] of tableMap) {
      if (writer.rows > 0) {
        nodeFiles.set(name, {
          csvPath: writer.csvPath,
          rows: writer.rows,
        });
      }
    }

    // Restore original process listener limit
    process.setMaxListeners(prevMax);

    return { nodeFiles, relCsvPath, relRows: relWriter.rows };
  } catch (error) {
    await Promise.allSettled(writers.map((writer) => Promise.resolve().then(() => writer.abort())));
    throw error;
  } finally {
    process.setMaxListeners(prevMax);
  }
};
