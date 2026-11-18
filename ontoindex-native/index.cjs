'use strict';

const native = require('./native.cjs');

function* byteFragments(value, maxBytes) {
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < value.length; ) {
    const code = value.charCodeAt(i);
    const next = value.charCodeAt(i + 1);
    const pair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    const size = pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (bytes + size > maxBytes) {
      yield Buffer.from(value.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += size;
    i += pair ? 2 : 1;
  }
  if (start < value.length) yield Buffer.from(value.slice(start));
}

class NativeCsvRowWriter {
  constructor(csvPath, header, maxBufferedBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
      throw new RangeError('CSV byte budget must be a positive safe integer');
    }
    this.csvPath = csvPath;
    this.rows = 0;
    this._rows = [String(header)];
    // Legacy field name retained; counts UTF-8 bytes, including the header/newlines.
    this._chars = Buffer.byteLength(String(header)) + 1;
    this._maxBufferedBytes = Math.max(4, maxBufferedBytes);
    this._headerWritten = false;
    this._failed = null;
  }

  addRow(row) {
    if (this._failed) throw this._failed;
    row = String(row);
    const rowBytes = Buffer.byteLength(row) + 1;
    if (this._rows.length > 0 && this._chars + rowBytes > this._maxBufferedBytes) {
      this._flush();
    }
    this._rows.push(row);
    this._chars += rowBytes;
    this.rows++;
    if (this._rows.length >= 500 || this._chars > this._maxBufferedBytes) {
      this._flush();
    }
  }

  _flush() {
    if (this._failed) throw this._failed;
    if (this._rows.length === 0) return;
    try {
      if (this._chars <= this._maxBufferedBytes) {
        this._write(Buffer.from(this._rows.join('\n') + '\n'));
      } else {
        for (const row of this._rows) {
          for (const bytes of byteFragments(row, this._maxBufferedBytes)) this._write(bytes);
          this._write(Buffer.from('\n'));
        }
      }
    } catch (error) {
      this._failed = error;
      throw error;
    } finally {
      this._rows.length = 0;
      this._chars = 0;
    }
  }

  _write(bytes) {
    native.appendCsvBytes(this.csvPath, bytes, !this._headerWritten);
    this._headerWritten = true;
  }

  async finish() {
    this._flush();
  }

  async abort() {
    this._failed ??= new Error('CSV writer aborted');
    this._rows.length = 0;
    this._chars = 0;
  }
}

const createCsvRowWriter = (csvPath, header, maxBufferedCharacters) =>
  new NativeCsvRowWriter(csvPath, header, maxBufferedCharacters);

module.exports = {
  NativeRootedDirectory: native.NativeRootedDirectory,
  openRootedDirectory: native.openRootedDirectory,
  NativeFileLock: native.NativeFileLock,
  tryAcquireFileLock: native.tryAcquireFileLock,
  createCsvRowWriter,
  createNativeCsvRowWriter: createCsvRowWriter,
  NativeHeritageMap: native.NativeHeritageMap,
  writeCsvRecords: native.writeCsvRecords,
  appendCsvBytes: native.appendCsvBytes,
  mergeRrfKeys: native.mergeRrfKeys,
  expandQueryTokens: native.expandQueryTokens,
  tarjanSccs: native.tarjanSccs,
  scanHttpContracts: native.scanHttpContracts,
  extractImportsNative: native.extractImportsNative,
  writeGraphBatchNative: native.writeGraphBatchNative,
};
