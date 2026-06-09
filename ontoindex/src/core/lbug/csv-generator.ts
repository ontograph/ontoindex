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
import { writeGraphBatch, isNativeGraphWriterEnabled } from '../../native/graph-writer.js';
import {
  createBufferedCsvRowWriter,
  type CsvRowWriter,
  type CsvRowWriterFactory,
} from './csv-row-writer.js';
import { selectCsvRowWriterFactory } from '../../native/csv-writer.js';

// ============================================================================
// CSV ESCAPE UTILITIES
// ============================================================================

export const sanitizeUTF8 = (str: string): string => {
  return str
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\uD800-\uDFFF]/g, '')
    .replace(/[\uFFFE\uFFFF]/g, '');
};

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

const toLbugStringArrayLiteral = (values: unknown): string => {
  if (!Array.isArray(values)) return '[]';
  return `[${values
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`)
    .join(',')}]`;
};

const optionalStringProperty = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback;

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

/**
 * LRU content cache — avoids re-reading the same source file for every
 * symbol defined in it. Sized generously so most files stay cached during
 * the single-pass node iteration.
 */
class FileContentCache {
  private cache = new Map<string, { content: string; lines?: string[] }>();
  private maxSize: number;
  private repoPath: string;

  constructor(repoPath: string, maxSize: number = 3000) {
    this.repoPath = repoPath;
    this.maxSize = maxSize;
  }

  async get(relativePath: string): Promise<string> {
    return (await this.getEntry(relativePath)).content;
  }

  async getLines(relativePath: string): Promise<string[]> {
    const entry = await this.getEntry(relativePath);
    if (!entry.content) return [];
    if (!entry.lines) entry.lines = entry.content.split('\n');
    return entry.lines;
  }

  private async getEntry(relativePath: string): Promise<{ content: string; lines?: string[] }> {
    if (!relativePath) return { content: '' };
    const cached = this.cache.get(relativePath);
    if (cached !== undefined) {
      this.cache.delete(relativePath);
      this.cache.set(relativePath, cached);
      return cached;
    }
    try {
      const fullPath = path.join(this.repoPath, relativePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      return this.set(relativePath, content);
    } catch {
      return this.set(relativePath, '');
    }
  }

  private set(key: string, content: string): { content: string; lines?: string[] } {
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    const entry = { content };
    this.cache.set(key, entry);
    return entry;
  }
}

const envInt = (name: string): number | undefined => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

interface ContentLimits {
  maxFileContentChars: number;
  maxSnippetChars: number;
}

const extractContent = async (
  node: GraphNode,
  contentCache: FileContentCache,
  limits: ContentLimits,
): Promise<string> => {
  const filePath = node.properties.filePath;
  if (node.label === 'File' && limits.maxFileContentChars === 0) return '';
  if (node.label !== 'File' && limits.maxSnippetChars === 0) return '';
  const content = await contentCache.get(filePath);
  if (!content) return '';
  if (node.label === 'Folder') return '';
  if (isBinaryContent(content)) return '[Binary file - content not stored]';

  if (node.label === 'File') {
    return content.length > limits.maxFileContentChars
      ? content.slice(0, limits.maxFileContentChars) + '\n... [truncated]'
      : content;
  }

  const startLine = node.properties.startLine;
  const endLine = node.properties.endLine;
  if (startLine === undefined || endLine === undefined) return '';

  const lines = await contentCache.getLines(filePath);
  const start = Math.max(0, startLine - 2);
  const end = Math.min(lines.length - 1, endLine + 2);
  const snippet = lines.slice(start, end + 1).join('\n');
  return snippet.length > limits.maxSnippetChars
    ? snippet.slice(0, limits.maxSnippetChars) + '\n... [truncated]'
    : snippet;
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

  // We open ~30 concurrent write-streams; raise process limit to suppress
  // MaxListenersExceededWarning (restored after all streams finish).
  const prevMax = process.getMaxListeners();
  process.setMaxListeners(prevMax + 40);
  const createWriter =
    options.createWriter ??
    (await selectCsvRowWriterFactory({
      fallbackFactory: createBufferedCsvRowWriter,
      onWarning: (message) => console.warn(message),
    }));

  const contentCache = new FileContentCache(repoPath);
  const largeGraph = graph.nodeCount > 25_000;
  const contentLimits: ContentLimits = {
    maxFileContentChars: envInt('ONTOINDEX_MAX_FILE_CONTENT_CHARS') ?? (largeGraph ? 0 : 10_000),
    maxSnippetChars: envInt('ONTOINDEX_MAX_SNIPPET_CHARS') ?? (largeGraph ? 1_000 : 5_000),
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

  const seenNodeIds = new Set<string>();

  if (isNativeGraphWriterEnabled()) {
    const BATCH_SIZE = 1000;
    let nodeBatch: GraphNode[] = [];
    let relBatch: any[] = [];
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
      nodeBatch.push(nodeToSerialize);

      if (nodeBatch.length >= BATCH_SIZE) {
        const { nodeCounts } = await writeGraphBatch(csvDir, nodeBatch, []);
        for (const [label, count] of nodeCounts) {
          nodeRowCounts.set(label, (nodeRowCounts.get(label) || 0) + count);
        }
        nodeBatch = [];
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
      relBatch.push(rel);
      totalRels++;
      if (relBatch.length >= BATCH_SIZE) {
        const { relCounts } = await writeGraphBatch(csvDir, [], relBatch);
        for (const [pair, count] of relCounts) {
          relRowCounts.set(pair, (relRowCounts.get(pair) || 0) + count);
        }
        relBatch = [];
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
        const keywords = node.properties.keywords || [];
        const keywordsStr = `[${keywords.map((k: string) => `'${k.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/,/g, '\\,')}'`).join(',')}]`;
        pendingWrite = writeCsvRow(
          communityWriter,
          [
            escapeCSVField(node.id),
            escapeCSVField(node.properties.name || ''),
            escapeCSVField(node.properties.heuristicLabel || ''),
            keywordsStr,
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
        const communities = node.properties.communities || [];
        const communitiesStr = `[${communities.map((c: string) => `'${c.replace(/'/g, "''")}'`).join(',')}]`;
        pendingWrite = writeCsvRow(
          processWriter,
          [
            escapeCSVField(node.id),
            escapeCSVField(node.properties.name || ''),
            escapeCSVField(node.properties.heuristicLabel || ''),
            escapeCSVField(node.properties.processType || ''),
            escapeCSVNumber(node.properties.stepCount, 0),
            escapeCSVField(communitiesStr),
            escapeCSVField(node.properties.entryPointId || ''),
            escapeCSVField(node.properties.terminalId || ''),
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
            escapeCSVField(toLbugStringArrayLiteral(node.properties.aliases)),
            escapeCSVField(toLbugStringArrayLiteral(node.properties.sourceDocuments)),
            escapeCSVField(toLbugStringArrayLiteral(node.properties.sourceFactKeys)),
            escapeCSVField(toLbugStringArrayLiteral(node.properties.resolutionKeys)),
            escapeCSVField(optionalStringProperty(node.properties.authority, 'advisory')),
            escapeCSVField(optionalStringProperty(node.properties.confidence, 'low')),
            escapeCSVField(optionalStringProperty(node.properties.evidenceClass, 'docs_evidence')),
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
        const responseKeys = node.properties.responseKeys || [];
        // LadybugDB array literal inside a quoted CSV field: escapeCSVField wraps in "..."
        // and the array uses single-quoted elements
        const keysStr = `[${responseKeys.map((k: string) => `'${k.replace(/'/g, "''")}'`).join(',')}]`;
        const errorKeys = node.properties.errorKeys || [];
        const errorKeysStr = `[${errorKeys.map((k: string) => `'${k.replace(/'/g, "''")}'`).join(',')}]`;
        const middleware = node.properties.middleware || [];
        const middlewareStr = `[${middleware.map((m: string) => `'${m.replace(/'/g, "''")}'`).join(',')}]`;
        pendingWrite = writeCsvRow(
          routeWriter,
          [
            escapeCSVField(node.id),
            escapeCSVField(node.properties.name || ''),
            escapeCSVField(node.properties.filePath || ''),
            escapeCSVField(keysStr),
            escapeCSVField(errorKeysStr),
            escapeCSVField(middlewareStr),
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
};
