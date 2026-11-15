'use strict';

const native = require('./native.cjs');

class NativeCsvRowWriter {
  constructor(csvPath, header, maxBufferedCharacters = 64 * 1024 * 1024) {
    this.csvPath = csvPath;
    this.rows = 0;
    this._header = header;
    this._rows = [];
    this._chars = 0;
    this._maxBufferedCharacters = maxBufferedCharacters;
    this._headerWritten = false;
  }

  addRow(row) {
    row = String(row);
    if (this._rows.length > 0 && this._chars + row.length + 1 > this._maxBufferedCharacters) {
      this._flush();
    }
    this._rows.push(row);
    this._chars += row.length + 1;
    this.rows++;
    if (this._rows.length >= 500 || this._chars > this._maxBufferedCharacters) {
      this._flush();
    }
  }

  _flush() {
    if (this._rows.length === 0) return;
    if (this._headerWritten) {
      native.appendCsvLines(this.csvPath, this._rows);
    } else {
      native.writeCsvLines(this.csvPath, this._header, this._rows);
      this._headerWritten = true;
    }
    this._rows.length = 0;
    this._chars = 0;
  }

  async finish() {
    this._flush();
    if (!this._headerWritten) {
      native.writeCsvLines(this.csvPath, this._header, []);
      this._headerWritten = true;
    }
  }
}

const createCsvRowWriter = (csvPath, header, maxBufferedCharacters) =>
  new NativeCsvRowWriter(csvPath, header, maxBufferedCharacters);

module.exports = {
  NativeFileLock: native.NativeFileLock,
  tryAcquireFileLock: native.tryAcquireFileLock,
  createCsvRowWriter,
  createNativeCsvRowWriter: createCsvRowWriter,
  NativeHeritageMap: native.NativeHeritageMap,
  writeCsvRecords: native.writeCsvRecords,
  mergeRrfKeys: native.mergeRrfKeys,
  expandQueryTokens: native.expandQueryTokens,
  tarjanSccs: native.tarjanSccs,
  scanHttpContracts: native.scanHttpContracts,
  extractImportsNative: native.extractImportsNative,
  writeGraphBatchNative: native.writeGraphBatchNative,
};
