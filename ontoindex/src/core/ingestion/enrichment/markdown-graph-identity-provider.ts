import { executeParameterized, type LbugQueryParams } from '../../lbug/pool-adapter.js';
import type { SourceIndexIdentity } from './docs-contracts.js';
import type { MarkdownHttpMethod } from './markdown-document-facts.js';

export type GraphIdentityCandidateType = 'symbol' | 'file' | 'test-file' | 'route';

export interface GraphIdentityCandidate {
  type: GraphIdentityCandidateType;
  id: string;
  name?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  method?: MarkdownHttpMethod;
  routePath?: string;
  sourceIndexId?: string;
  graphSchemaVersion?: number;
  confidence: number;
}

export interface RouteIdentityCandidate extends GraphIdentityCandidate {
  type: 'route';
  method?: MarkdownHttpMethod;
  routePath?: string;
}

export interface SymbolIdentityQuery {
  mention: string;
  filePathHint?: string;
  kindHint?: string;
  maxCandidates: number;
}

export interface FileIdentityQuery {
  mention: string;
  pathHint?: string;
  maxCandidates: number;
}

export interface RouteIdentityQuery {
  method: MarkdownHttpMethod;
  path: string;
  maxCandidates: number;
}

export interface TestIdentityQuery {
  mention: string;
  pathHint?: string;
  maxCandidates: number;
}

export interface GraphIdentityProvider {
  findSymbols(query: SymbolIdentityQuery): Promise<GraphIdentityCandidate[]>;
  findFiles(query: FileIdentityQuery): Promise<GraphIdentityCandidate[]>;
  findRoutes(query: RouteIdentityQuery): Promise<RouteIdentityCandidate[]>;
  findTestFiles(query: TestIdentityQuery): Promise<GraphIdentityCandidate[]>;
}

export interface InMemoryGraphIdentityProviderInput {
  symbols?: readonly GraphIdentityCandidate[];
  files?: readonly GraphIdentityCandidate[];
  routes?: readonly RouteIdentityCandidate[];
  testFiles?: readonly GraphIdentityCandidate[];
}

export class InMemoryGraphIdentityProvider implements GraphIdentityProvider {
  private readonly symbols: GraphIdentityCandidate[];
  private readonly files: GraphIdentityCandidate[];
  private readonly routes: RouteIdentityCandidate[];
  private readonly testFiles: GraphIdentityCandidate[];

  constructor(input: InMemoryGraphIdentityProviderInput = {}) {
    this.symbols = normalizeCandidates(input.symbols ?? [], 'symbol');
    this.files = normalizeCandidates(input.files ?? [], 'file');
    this.routes = normalizeCandidates(input.routes ?? [], 'route') as RouteIdentityCandidate[];
    this.testFiles = normalizeCandidates(input.testFiles ?? [], 'test-file');
  }

  async findSymbols(query: SymbolIdentityQuery): Promise<GraphIdentityCandidate[]> {
    const mention = normalizeLookup(query.mention);
    return selectCandidates(
      this.symbols.filter((candidate) => matchesName(candidate, mention, query.filePathHint)),
      query.maxCandidates,
    );
  }

  async findFiles(query: FileIdentityQuery): Promise<GraphIdentityCandidate[]> {
    const mention = normalizeLookup(query.pathHint ?? query.mention);
    return selectCandidates(
      this.files.filter((candidate) => matchesFile(candidate, mention)),
      query.maxCandidates,
    );
  }

  async findRoutes(query: RouteIdentityQuery): Promise<RouteIdentityCandidate[]> {
    const routeKey = `${query.method} ${query.path}`;
    return selectCandidates(
      this.routes.filter((candidate) => {
        if (candidate.method !== undefined && candidate.method !== query.method) return false;
        return [candidate.id, candidate.name, candidate.routePath].some(
          (value) => value === routeKey || value === query.path,
        );
      }),
      query.maxCandidates,
    ) as RouteIdentityCandidate[];
  }

  async findTestFiles(query: TestIdentityQuery): Promise<GraphIdentityCandidate[]> {
    const mention = normalizeLookup(query.pathHint ?? query.mention);
    return selectCandidates(
      this.testFiles.filter((candidate) => matchesFile(candidate, mention)),
      query.maxCandidates,
    );
  }
}

export type GraphIdentityQueryExecutor = <TRow extends GraphIdentityRow = GraphIdentityRow>(
  repoId: string,
  cypher: string,
  params: LbugQueryParams,
) => Promise<TRow[]>;

export interface GraphIdentityRow {
  readonly [field: string]: unknown;
  readonly [index: number]: unknown;
}

export interface LbugGraphIdentityProviderOptions {
  repoId: string;
  sourceIndex?: SourceIndexIdentity;
  query?: GraphIdentityQueryExecutor;
}

export class LbugGraphIdentityProvider implements GraphIdentityProvider {
  private readonly repoId: string;
  private readonly sourceIndex?: SourceIndexIdentity;
  private readonly query: GraphIdentityQueryExecutor;

  constructor(options: LbugGraphIdentityProviderOptions) {
    this.repoId = requireNonEmpty(options.repoId, 'repoId');
    this.sourceIndex = options.sourceIndex;
    this.query = options.query ?? executeParameterized;
  }

  async findSymbols(query: SymbolIdentityQuery): Promise<GraphIdentityCandidate[]> {
    const predicates = ['n.name = $mention'];
    const params: Record<string, unknown> = { mention: query.mention, limit: query.maxCandidates };
    if (query.filePathHint !== undefined) {
      predicates.push('n.filePath CONTAINS $filePathHint');
      params.filePathHint = query.filePathHint;
    }
    if (query.kindHint !== undefined) {
      predicates.push('labels(n)[0] = $kindHint');
      params.kindHint = query.kindHint;
    }
    const rows = await this.query(
      this.repoId,
      `
      MATCH (n)
      WHERE ${predicates.join(' AND ')}
      RETURN n.id AS id, n.name AS name, labels(n)[0] AS label, n.filePath AS filePath,
        n.startLine AS startLine, n.endLine AS endLine
      LIMIT $limit
      `,
      params,
    );
    return selectCandidates(
      rows.map((row) => this.symbolCandidate(row)),
      query.maxCandidates,
    );
  }

  async findFiles(query: FileIdentityQuery): Promise<GraphIdentityCandidate[]> {
    return this.findFileCandidates(query.pathHint ?? query.mention, query.maxCandidates, false);
  }

  async findTestFiles(query: TestIdentityQuery): Promise<GraphIdentityCandidate[]> {
    return this.findFileCandidates(query.pathHint ?? query.mention, query.maxCandidates, true);
  }

  async findRoutes(query: RouteIdentityQuery): Promise<RouteIdentityCandidate[]> {
    const routeKey = `${query.method} ${query.path}`;
    const rows = await this.query(
      this.repoId,
      `
      MATCH (n:Route)
      WHERE n.id = $routeKey OR n.name = $routeKey OR n.name = $path
      RETURN n.id AS id, n.name AS name, n.filePath AS filePath
      LIMIT $limit
      `,
      { routeKey, path: query.path, limit: query.maxCandidates },
    );
    return selectCandidates(
      rows.map((row) => this.routeCandidate(row, query.method, query.path)),
      query.maxCandidates,
    ) as RouteIdentityCandidate[];
  }

  private async findFileCandidates(
    mention: string,
    maxCandidates: number,
    testsOnly: boolean,
  ): Promise<GraphIdentityCandidate[]> {
    const rows = await this.query(
      this.repoId,
      `
      MATCH (n:File)
      WHERE n.filePath = $mention OR n.filePath CONTAINS $mention
      RETURN n.id AS id, n.name AS name, n.filePath AS filePath
      LIMIT $limit
      `,
      { mention, limit: maxCandidates },
    );
    const candidates = rows.map((row) => this.fileCandidate(row, testsOnly ? 'test-file' : 'file'));
    return selectCandidates(
      testsOnly
        ? candidates.filter((candidate) => isTestPath(candidate.filePath ?? ''))
        : candidates,
      maxCandidates,
    );
  }

  private symbolCandidate(row: GraphIdentityRow): GraphIdentityCandidate {
    return this.stampCandidate({
      type: 'symbol',
      id: readString(row, 'id', 0),
      name: readOptionalString(row, 'name', 1),
      filePath: readOptionalString(row, 'filePath', 3),
      startLine: readOptionalNumber(row, 'startLine', 4),
      endLine: readOptionalNumber(row, 'endLine', 5),
      confidence: 0.9,
    });
  }

  private fileCandidate(row: GraphIdentityRow, type: 'file' | 'test-file'): GraphIdentityCandidate {
    return this.stampCandidate({
      type,
      id: readString(row, 'id', 0),
      name: readOptionalString(row, 'name', 1),
      filePath: readOptionalString(row, 'filePath', 2),
      confidence: 0.9,
    });
  }

  private routeCandidate(
    row: GraphIdentityRow,
    method: MarkdownHttpMethod,
    routePath: string,
  ): RouteIdentityCandidate {
    return this.stampCandidate({
      type: 'route',
      id: readString(row, 'id', 0),
      name: readOptionalString(row, 'name', 1),
      filePath: readOptionalString(row, 'filePath', 2),
      method,
      routePath,
      confidence: 0.9,
    }) as RouteIdentityCandidate;
  }

  private stampCandidate(candidate: GraphIdentityCandidate): GraphIdentityCandidate {
    return {
      ...candidate,
      sourceIndexId: this.sourceIndex?.sourceIndexId,
      graphSchemaVersion: this.sourceIndex?.graphSchemaVersion,
    };
  }
}

function normalizeCandidates(
  candidates: readonly GraphIdentityCandidate[],
  fallbackType: GraphIdentityCandidateType,
): GraphIdentityCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    type: candidate.type ?? fallbackType,
    confidence: normalizeConfidence(candidate.confidence),
  }));
}

function selectCandidates<TCandidate extends GraphIdentityCandidate>(
  candidates: readonly TCandidate[],
  maxCandidates: number,
): TCandidate[] {
  return [...candidates].sort(compareCandidates).slice(0, normalizeLimit(maxCandidates));
}

function compareCandidates(a: GraphIdentityCandidate, b: GraphIdentityCandidate): number {
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  const aPath = a.filePath ?? '';
  const bPath = b.filePath ?? '';
  if (aPath !== bPath) return aPath.localeCompare(bPath);
  return a.id.localeCompare(b.id);
}

function matchesName(
  candidate: GraphIdentityCandidate,
  mention: string,
  filePathHint?: string,
): boolean {
  if (filePathHint !== undefined && candidate.filePath !== undefined) {
    if (!candidate.filePath.includes(filePathHint)) return false;
  }
  return [candidate.id, candidate.name].some((value) => normalizeLookup(value ?? '') === mention);
}

function matchesFile(candidate: GraphIdentityCandidate, mention: string): boolean {
  return [candidate.id, candidate.name, candidate.filePath].some((value) => {
    const normalized = normalizeLookup(value ?? '');
    return normalized === mention || normalized.endsWith(`/${mention}`);
  });
}

function isTestPath(filePath: string): boolean {
  return (
    filePath.includes('.test.') ||
    filePath.includes('.spec.') ||
    filePath.startsWith('test/') ||
    filePath.startsWith('tests/') ||
    filePath.includes('/__tests__/')
  );
}

function normalizeLookup(value: string): string {
  return value.trim().replace(/^`|`$/g, '');
}

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('maxCandidates must be a positive integer');
  }
  return value;
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('candidate confidence must be a finite number from 0 to 1');
  }
  return value;
}

function readValue(row: GraphIdentityRow, key: string, index: number): unknown {
  const keyedValue = row[key];
  if (keyedValue !== undefined && keyedValue !== null) return keyedValue;
  return row[index] ?? row[String(index)];
}

function readString(row: GraphIdentityRow, key: string, index: number): string {
  const value = readValue(row, key, index);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`LadybugDB identity row field ${key} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(row: GraphIdentityRow, key: string, index: number): string | undefined {
  const value = readValue(row, key, index);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readOptionalNumber(row: GraphIdentityRow, key: string, index: number): number | undefined {
  const value = readValue(row, key, index);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requireNonEmpty(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}
