import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ParsedFile } from 'ontoindex-shared';
import type { ImportConfigObservations } from '../language-config.js';
import type { ScopeExtractionRecord } from '../scope-extractor-bridge.js';
import {
  decodeParsedFileRecord,
  encodeParsedFileRecord,
  ParsedFileRecordError,
} from './parse-scope-codec.js';

export interface ScopeRetentionRequest {
  deadline: number;
  signal?: AbortSignal;
  artifactAllowance: { remainingBytes: number };
}
export interface ScopeRetentionHandle {
  readonly status: 'retained' | 'incomplete';
  readonly seedReady: false;
  readonly evidenceScope: 'observed-inventory';
  readonly reasons: readonly string[];
  readonly inventory: readonly { filePath: string; status: string }[];
  readonly bytes: number;
  readonly recordCount: number;
  readonly inputEvidence: Readonly<{
    domain: 'parser-text-utf8';
    complete: boolean;
    configuration: ImportConfigObservations | null;
    sources: readonly Readonly<{ filePath: string; sha256: string; byteLength: number }>[];
    reasons: readonly string[];
  }>;
  iterate(): AsyncIterable<readonly ParsedFile[]>;
  dispose(): Promise<void>;
}
const ceilings = {
  maxBytes: 64 * 1024 * 1024,
  maxRecords: 100_000,
  maxRecordBytes: 256 * 1024,
  readChunkBytes: 1024 * 1024,
  batchBytes: 1024 * 1024,
  batchRecords: 1000,
};

/** Parse-owned, opt-in transient store. Retained observed inputs are never a complete seed. */
export class ScopeRetentionStage implements ScopeRetentionHandle {
  readonly seedReady = false;
  readonly evidenceScope = 'observed-inventory';
  private readonly limits: typeof ceilings;
  private readonly issues = new Set<string>();
  private readonly entries = new Map<
    string,
    { artifact: boolean; outcome?: string; skipped?: boolean; expected?: boolean }
  >();
  private inventoryBytes = 0;
  private inputBytes = 0;
  private configuration: ImportConfigObservations | null = null;
  private readonly sources = new Map<
    string,
    Readonly<{ filePath: string; sha256: string; byteLength: number }>
  >();
  private readonly inputIssues = new Set<string>();
  private queued: string[] = [];
  private directory?: string;
  private filePath?: string;
  private pending: Promise<void> = Promise.resolve();
  private disposing?: Promise<void>;
  private disposed = false;
  private retainedBytes = 0;
  private retainedRecords = 0;
  private captureAttempts = 0;
  private reconciled = false;
  private replayActive = false;
  private pendingReader?: Promise<FileHandle | undefined>;
  private readers = new Set<FileHandle>();
  private closingReaders = new Map<FileHandle, Promise<void>>();

  constructor(
    private readonly request: ScopeRetentionRequest,
    limits: Partial<typeof ceilings> = {},
  ) {
    this.limits = { ...ceilings };
    for (const key of Object.keys(ceilings) as (keyof typeof ceilings)[]) {
      const value = limits[key] ?? ceilings[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > ceilings[key])
        throw new Error('Invalid scope retention limit');
      this.limits[key] = value;
    }
    if (
      !Number.isFinite(request.deadline) ||
      !Number.isSafeInteger(request.artifactAllowance.remainingBytes) ||
      request.artifactAllowance.remainingBytes < 0
    )
      throw new Error('Invalid scope retention request');
  }
  get bytes(): number {
    return this.retainedBytes;
  }
  get recordCount(): number {
    return this.retainedRecords;
  }
  get inputEvidence(): ScopeRetentionHandle['inputEvidence'] {
    const reasons = new Set(this.inputIssues);
    if (this.status !== 'retained') reasons.add('artifact-incomplete');
    if (!this.configuration?.complete) reasons.add('configuration-incomplete');
    for (const [filePath, entry] of this.entries) {
      if (entry.expected && !this.sources.has(filePath)) reasons.add('missing-source');
    }
    if (this.reconciled)
      for (const filePath of this.sources.keys()) {
        if (!this.entries.get(filePath)?.expected) reasons.add('unexpected-source');
      }
    return Object.freeze({
      domain: 'parser-text-utf8',
      complete: reasons.size === 0,
      configuration: this.configuration,
      sources: Object.freeze([...this.sources.values()]),
      reasons: Object.freeze([...reasons]),
    });
  }
  private inputIssue(reason: string): void {
    if (this.inputIssues.size < 100) this.inputIssues.add(reason);
  }
  private inputRoom(bytes: number): boolean {
    return (
      bytes <= this.request.artifactAllowance.remainingBytes &&
      this.retainedBytes + this.inputBytes + bytes <= this.limits.maxBytes
    );
  }
  captureParserInputs(files: readonly { path: string; content: string }[]): void {
    let count = 0;
    for (const file of files) {
      if (!this.check()) return;
      if (
        ++count > this.limits.maxRecords ||
        typeof file.path !== 'string' ||
        typeof file.content !== 'string' ||
        Buffer.byteLength(file.path) > this.limits.maxRecordBytes
      ) {
        this.inputIssue('source-limit');
        return;
      }
      // UTF-8 replaces unpaired surrogates, so they cannot identify exact parser text.
      const unpairedSurrogate =
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      if (unpairedSurrogate.test(file.content) || unpairedSurrogate.test(file.path)) {
        this.inputIssue('source-invalid-utf8');
        continue;
      }
      const sha256 = createHash('sha256').update(file.content, 'utf8').digest('hex');
      const byteLength = Buffer.byteLength(file.content, 'utf8');
      const previous = this.sources.get(file.path);
      if (previous) {
        if (previous.sha256 !== sha256 || previous.byteLength !== byteLength)
          this.inputIssue('source-conflict');
        continue;
      }
      if (this.sources.size >= this.limits.maxRecords) {
        this.inputIssue('source-limit');
        return;
      }
      const source = { filePath: file.path, sha256, byteLength };
      const bytes = Buffer.byteLength(JSON.stringify(source), 'utf8');
      if (!this.inputRoom(bytes)) {
        this.inputIssue('input-byte-limit');
        return;
      }
      this.sources.set(file.path, Object.freeze(source));
      this.inputBytes += bytes;
      this.request.artifactAllowance.remainingBytes -= bytes;
    }
  }
  captureConfigObservations(observations: ImportConfigObservations | undefined): void {
    if (!this.check()) return;
    if (!observations) {
      this.inputIssue('configuration-missing');
      return;
    }
    const budget = Math.min(
      1024 * 1024,
      this.request.artifactAllowance.remainingBytes,
      this.limits.maxBytes - this.retainedBytes - this.inputBytes,
    );
    // Bound the metadata tree before constructing its detached copy or serialized digest input.
    let bytes = 0;
    let nodes = 0;
    const measure = (value: unknown, depth: number): boolean => {
      if (++nodes > 100_000 || depth > 6 || bytes > budget) return false;
      if (typeof value === 'string') {
        if (Buffer.byteLength(value, 'utf8') > budget) return false;
        bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
      } else if (
        value === null ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isSafeInteger(value))
      ) {
        bytes += String(value).length;
      } else if (Array.isArray(value)) {
        if (value.length > 10_000) return false;
        bytes += 2 + Math.max(0, value.length - 1);
        for (const child of value) if (!measure(child, depth + 1)) return false;
      } else if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length > 12) return false;
        bytes += 2 + Math.max(0, keys.length - 1);
        for (const key of keys) {
          if (!measure(key, depth + 1)) return false;
          bytes++;
          if (!measure((value as Record<string, unknown>)[key], depth + 1)) return false;
        }
      } else return false;
      return bytes <= budget;
    };
    if (!measure(observations, 0)) {
      this.inputIssue('configuration-limit');
      return;
    }
    const digest = /^[a-f0-9]{64}$/;
    const keysAllowed = (value: object, keys: readonly string[]): boolean =>
      Object.keys(value).every((key) => keys.includes(key));
    if (
      !keysAllowed(observations, ['version', 'complete', 'digest', 'records', 'issues']) ||
      observations.version !== 1 ||
      typeof observations.complete !== 'boolean' ||
      !Array.isArray(observations.records) ||
      observations.records.length > 4096 ||
      !Array.isArray(observations.issues) ||
      !observations.issues.every((issue) => typeof issue === 'string') ||
      (observations.digest !== null &&
        (typeof observations.digest !== 'string' || !digest.test(observations.digest)))
    ) {
      this.inputIssue('configuration-invalid');
      return;
    }
    let directoryEntries = 0;
    for (const record of observations.records) {
      if (!record || typeof record.path !== 'string') {
        this.inputIssue('configuration-invalid');
        return;
      }
      const allowed =
        record.kind === 'file'
          ? ['kind', 'path', 'status', 'sha256', 'byteLength', 'errorCode']
          : record.kind === 'directory'
            ? ['kind', 'path', 'status', 'entries', 'errorCode']
            : record.kind === 'traversal'
              ? [
                  'kind',
                  'path',
                  'maxDepth',
                  'maxDirs',
                  'dirsScanned',
                  'depthLimited',
                  'directoryLimited',
                ]
              : ['kind', 'path'];
      if (!keysAllowed(record, allowed)) {
        this.inputIssue('configuration-invalid');
        return;
      }
      if (record.kind === 'file' || record.kind === 'directory') {
        if (
          !['present', 'absent', 'failed'].includes(record.status) ||
          (record.errorCode !== undefined &&
            (typeof record.errorCode !== 'string' ||
              !/^[A-Z][A-Z0-9_]{0,31}$/.test(record.errorCode)))
        ) {
          this.inputIssue('configuration-invalid');
          return;
        }
        if (
          record.kind === 'file' &&
          record.status === 'present' &&
          (typeof record.sha256 !== 'string' ||
            !digest.test(record.sha256) ||
            !Number.isSafeInteger(record.byteLength) ||
            record.byteLength! < 0)
        ) {
          this.inputIssue('configuration-invalid');
          return;
        }
        if (record.kind === 'directory' && record.status === 'present') {
          if (
            !Array.isArray(record.entries) ||
            (directoryEntries += record.entries.length) > 10_000 ||
            !record.entries.every(
              (entry) =>
                entry &&
                keysAllowed(entry, ['name', 'kind']) &&
                typeof entry.name === 'string' &&
                ['file', 'directory', 'symlink', 'other'].includes(entry.kind),
            )
          ) {
            this.inputIssue('configuration-invalid');
            return;
          }
        }
      } else if (record.kind === 'traversal') {
        if (
          record.path !== '.' ||
          record.maxDepth !== 5 ||
          record.maxDirs !== 100 ||
          !Number.isSafeInteger(record.dirsScanned) ||
          record.dirsScanned < 0 ||
          record.dirsScanned > 100 ||
          typeof record.depthLimited !== 'boolean' ||
          typeof record.directoryLimited !== 'boolean'
        ) {
          this.inputIssue('configuration-invalid');
          return;
        }
      } else if (record.kind !== 'parse-error') {
        this.inputIssue('configuration-invalid');
        return;
      }
      if (
        observations.complete &&
        (record.kind === 'parse-error' ||
          ('status' in record && record.status === 'failed') ||
          (record.kind === 'traversal' && (record.depthLimited || record.directoryLimited)))
      ) {
        this.inputIssue('configuration-invalid');
        return;
      }
    }
    if (
      observations.complete &&
      (observations.issues.length !== 0 ||
        observations.digest !==
          createHash('sha256')
            .update(JSON.stringify({ version: 1, records: observations.records }))
            .digest('hex'))
    ) {
      this.inputIssue('configuration-invalid');
      return;
    }
    const encoded = JSON.stringify(observations);
    if (this.configuration) {
      if (JSON.stringify(this.configuration) !== encoded) this.inputIssue('configuration-conflict');
      return;
    }
    if (!this.inputRoom(bytes)) {
      this.inputIssue('input-byte-limit');
      return;
    }
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    const configuration: ImportConfigObservations = JSON.parse(encoded);
    freeze(configuration);
    this.configuration = configuration;
    this.inputBytes += bytes;
    this.request.artifactAllowance.remainingBytes -= bytes;
  }
  get reasons(): readonly string[] {
    return [...this.issues];
  }
  get inventory(): readonly { filePath: string; status: string }[] {
    return Array.from(this.entries, ([filePath, entry]) => ({
      filePath,
      status: this.entryStatus(entry),
    }));
  }
  get status(): 'retained' | 'incomplete' {
    if (!this.check() || !this.reconciled || !this.entries.size || this.issues.size)
      return 'incomplete';
    for (const entry of this.entries.values())
      if (this.entryStatus(entry) !== 'retained') return 'incomplete';
    return 'retained';
  }
  private entryStatus(entry: { artifact: boolean; outcome?: string; skipped?: boolean }): string {
    return entry.skipped
      ? 'skipped'
      : entry.outcome === undefined
        ? 'missing-outcome'
        : entry.outcome !== 'success'
          ? entry.outcome
          : !entry.artifact
            ? 'missing-artifact'
            : 'retained';
  }
  private issue(reason: string): void {
    if (this.issues.size < 100) this.issues.add(reason);
  }
  private check(): boolean {
    if (this.disposed) {
      this.issue('disposed');
      return false;
    }
    if (this.request.signal?.aborted) {
      this.issue('cancelled');
      return false;
    }
    if (Date.now() >= this.request.deadline) {
      this.issue('deadline');
      return false;
    }
    return true;
  }
  private entry(filePath: unknown) {
    if (typeof filePath !== 'string' || filePath.length > this.limits.maxRecordBytes) {
      this.issue('inventory-limit');
      return;
    }
    const found = this.entries.get(filePath);
    if (found) return found;
    const size = Buffer.byteLength(filePath, 'utf8') + 64;
    if (
      this.entries.size >= this.limits.maxRecords ||
      this.inventoryBytes + size > this.limits.maxBytes
    ) {
      this.issue('inventory-limit');
      return;
    }
    this.inventoryBytes += size;
    const entry: { artifact: boolean; outcome?: string; skipped?: boolean; expected?: boolean } = {
      artifact: false,
    };
    this.entries.set(filePath, entry);
    return entry;
  }
  capture(files: readonly ParsedFile[]): void {
    this.reconciled = false;
    for (const file of files) {
      if (!this.check()) return;
      if (++this.captureAttempts > this.limits.maxRecords) {
        this.issue('record-count-limit');
        return;
      }
      if (this.retainedRecords >= this.limits.maxRecords) {
        this.issue('record-count-limit');
        return;
      }
      let encoded: string;
      try {
        const available = Math.min(
          this.limits.maxRecordBytes,
          this.limits.batchBytes,
          this.limits.maxBytes - this.retainedBytes - this.inputBytes,
          this.request.artifactAllowance.remainingBytes,
        );
        if (available < 1) {
          this.issue('artifact-byte-limit');
          return;
        }
        encoded = encodeParsedFileRecord(file, available);
      } catch (error) {
        if (!(error instanceof ParsedFileRecordError)) throw error;
        this.issue(error.reason);
        continue;
      }
      const entry = this.entry(file.filePath);
      if (!entry) continue;
      if (entry.artifact) this.issue('duplicate-artifact');
      const bytes = Buffer.byteLength(encoded, 'utf8');
      if (!this.inputRoom(bytes)) {
        this.issue('artifact-byte-limit');
        return;
      }
      this.request.artifactAllowance.remainingBytes -= bytes;
      this.retainedBytes += bytes;
      this.retainedRecords++;
      entry.artifact = true;
      this.queued.push(encoded);
    }
  }
  recordOutcomes(outcomes: readonly ScopeExtractionRecord[]): void {
    this.reconciled = false;
    let count = 0;
    for (const outcome of outcomes) {
      if (!this.check()) return;
      if (++count > this.limits.maxRecords) {
        this.issue('inventory-limit');
        return;
      }
      const entry = this.entry(outcome.filePath);
      if (!entry) continue;
      if (entry.outcome !== undefined) this.issue('duplicate-outcome');
      entry.outcome = ['success', 'failed', 'unsupported'].includes(outcome.status)
        ? outcome.status
        : 'invalid-outcome';
      if (entry.outcome !== 'success') this.issue(entry.outcome);
    }
  }
  reconcile(expectedPaths: Iterable<string>, skippedPaths: Iterable<string> = []): void {
    this.reconciled = false;
    for (const entry of this.entries.values()) {
      entry.expected = false;
      entry.skipped = false;
    }
    let count = 0;
    for (const filePath of expectedPaths) {
      if (!this.check()) return;
      if (++count > this.limits.maxRecords) {
        this.issue('inventory-limit');
        return;
      }
      const entry = this.entry(filePath);
      if (entry) {
        if (entry.expected) this.issue('duplicate-expected-path');
        entry.expected = true;
      }
    }
    count = 0;
    for (const filePath of skippedPaths) {
      if (!this.check()) return;
      if (++count > this.limits.maxRecords) {
        this.issue('inventory-limit');
        return;
      }
      const entry = this.entry(filePath);
      if (entry) entry.skipped = true;
    }
    for (const entry of this.entries.values()) {
      const status = this.entryStatus(entry);
      if (status !== 'retained') this.issue(status);
      if (!entry.expected) this.issue('unexpected-artifact-or-outcome');
    }
    if (!this.entries.size) this.issue('empty-observed-inventory');
    this.reconciled = true;
  }
  flush(): Promise<void> {
    this.pending = this.pending
      .then(async () => {
        if (!this.check()) return;
        if (!this.queued.length) return;
        if (!this.directory) {
          this.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-parse-scopes-'));
          this.filePath = path.join(this.directory, 'stage.jsonl');
        }
        // One bounded record per write; never construct a whole-chunk encoded copy.
        let written = 0;
        while (written < this.queued.length && this.check()) {
          const record = this.queued[written];
          await fs.appendFile(this.filePath!, record, { encoding: 'utf8', mode: 0o600 });
          written++;
        }
        this.queued.splice(0, written);
      })
      .catch((error) => {
        this.issue('write-failed');
        throw error;
      });
    return this.pending;
  }
  async *iterate(): AsyncIterable<readonly ParsedFile[]> {
    if (this.replayActive) throw new ParsedFileRecordError('concurrent-replay');
    this.replayActive = true;
    try {
      await this.flush();
      if (!this.check() || !this.filePath) return;
      this.pendingReader = fs.open(this.filePath, 'r').then(async (reader) => {
        this.readers.add(reader);
        if (!this.check()) {
          await this.closeReader(reader);
          return;
        }
        return reader;
      });
      const reader = await this.pendingReader;
      if (!reader) return;
      const buffer = Buffer.alloc(this.limits.readChunkBytes);
      let pieces: Buffer[] = [];
      let lineBytes = 0;
      let batch: ParsedFile[] = [];
      let batchBytes = 0;
      let count = 0;
      let bytes = 0;
      try {
        while (this.check()) {
          const { bytesRead } = await reader.read(buffer, 0, buffer.length, null);
          if (!this.check()) return;
          if (!bytesRead) break;
          let start = 0;
          for (let i = 0; i < bytesRead; i++) {
            if (buffer[i] !== 10) continue;
            const part = buffer.subarray(start, i + 1);
            lineBytes += part.length;
            if (lineBytes > this.limits.maxRecordBytes || lineBytes > this.limits.batchBytes)
              throw new ParsedFileRecordError('record-byte-limit');
            pieces.push(part);
            const line = Buffer.concat(pieces, lineBytes).toString('utf8');
            bytes += lineBytes;
            count++;
            if (bytes > this.retainedBytes || count > this.retainedRecords)
              throw new ParsedFileRecordError('stage-size-mismatch');
            if (
              batch.length &&
              (batch.length >= this.limits.batchRecords ||
                batchBytes + lineBytes > this.limits.batchBytes)
            ) {
              yield batch;
              batch = [];
              batchBytes = 0;
              if (!this.check()) return;
            }
            batch.push(decodeParsedFileRecord(line));
            batchBytes += lineBytes;
            pieces = [];
            lineBytes = 0;
            start = i + 1;
          }
          if (start < bytesRead) {
            lineBytes += bytesRead - start;
            if (lineBytes > this.limits.maxRecordBytes)
              throw new ParsedFileRecordError('record-byte-limit');
            pieces.push(Buffer.from(buffer.subarray(start, bytesRead)));
          }
        }
        if (!this.check()) return;
        if (lineBytes || count !== this.retainedRecords || bytes !== this.retainedBytes)
          throw new ParsedFileRecordError('stage-size-mismatch');
        if (batch.length) yield batch;
      } catch (error) {
        this.issue('replay-failed');
        throw error;
      } finally {
        await this.closeReader(reader);
      }
    } finally {
      this.pendingReader = undefined;
      this.replayActive = false;
    }
  }
  private closeReader(reader: FileHandle): Promise<void> {
    const closing = this.closingReaders.get(reader);
    if (closing) return closing;
    if (!this.readers.has(reader)) return Promise.resolve();
    const pending = reader.close().finally(() => {
      this.readers.delete(reader);
      this.closingReaders.delete(reader);
    });
    this.closingReaders.set(reader, pending);
    return pending;
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.entries.clear();
    this.inventoryBytes = 0;
    this.configuration = null;
    this.sources.clear();
    this.disposing = (async () => {
      await this.pending.catch(() => undefined);
      await this.pendingReader?.catch(() => undefined);
      // Await active I/O before deleting its storage; close is idempotent on FileHandle.
      const closed = await Promise.allSettled(
        [...this.readers].map((reader) => this.closeReader(reader)),
      );
      this.readers.clear();
      if (this.directory) await fs.rm(this.directory, { recursive: true, force: true });
      this.directory = undefined;
      this.filePath = undefined;
      this.queued = [];
      this.request.artifactAllowance.remainingBytes += this.retainedBytes + this.inputBytes;
      this.inputBytes = 0;
      const failed = closed.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    return this.disposing;
  }
}
