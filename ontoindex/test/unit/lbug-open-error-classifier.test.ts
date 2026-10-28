import { describe, expect, it } from 'vitest';
import { classifyLbugOpenError } from '../../src/core/lbug/pool-adapter.js';
import { classifyLbugOpenError as classifyTypedLbugOpenError } from '../../src/core/lbug/open-error.js';

describe('classifyLbugOpenError', () => {
  it.each([
    ['Storage exception: Checksum verification failed, the WAL file is corrupted.', 'wal'],
    ['Runtime exception: Reading past the end of the file /x/y.wal with size 1 at offset 1', 'wal'],
    ['Could not set lock on file', 'lock'],
    ['database lock held', 'lock'],
    ['resource temporarily unavailable', 'lock'],
    ['EAGAIN', 'lock'],
    ['block device error', 'other'],
    ['clock skew', 'other'],
    ['unlocked', 'other'],
    ['blocked', 'other'],
    ['EACCES: permission denied', 'other'],
    ['Unsupported storage version', 'other'],
    ['out of memory', 'other'],
    ['bad WAL', 'other'],
  ])('%s => %s', (message, expected) => {
    expect(classifyLbugOpenError(message)).toBe(expected);
  });
});

describe('typed Lbug open error classification', () => {
  const nativeMessage =
    'Runtime exception: Unable to open database. The file is not a valid Lbug database file!';

  it.each([
    [nativeMessage, 'corrupt'],
    [new Error(nativeMessage, { cause: new Error('native open failed') }), 'corrupt'],
    [`Could not set lock on database file. ${nativeMessage}`, 'lock'],
    [`EACCES: permission denied opening database file. ${nativeMessage}`, 'permission'],
    ['Unable to open database: out of memory', 'resource'],
    [
      'Runtime exception: Reading past the end of the file /p/lbug with size 4415488 at offset 8818688',
      'corrupt',
    ],
    [
      'IO exception: Cannot read from file: /p/lbug fileDescriptor: 21 numBytesRead: 0 numBytesToRead: 4096 position: 4901969379328',
      'corrupt',
    ],
    ['Could not set lock on file. Cannot read from file: /p/lbug', 'lock'],
    ['EACCES: permission denied. Cannot read from file: /p/lbug', 'permission'],
    ['out of memory while Reading past the end of the file', 'resource'],
  ])('%s => %s', (error, expected) => {
    expect(classifyTypedLbugOpenError(error)).toBe(expected);
  });
});
