'use strict';

const native = require('./native.cjs');

class NativeCsvRowWriter {
  constructor(csvPath, header) {
    this.csvPath = csvPath;
    this.rows = 0;
    this._header = header;
    this._rows = [];
  }

  addRow(row) {
    this._rows.push(String(row));
    this.rows++;
  }

  async finish() {
    native.writeCsvLines(this.csvPath, this._header, this._rows);
    this._rows.length = 0;
  }
}

const createCsvRowWriter = (csvPath, header) => new NativeCsvRowWriter(csvPath, header);

module.exports = {
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
