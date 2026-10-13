import { describe, expect, it } from 'vitest';
import { classifyLbugOpenError } from '../../src/core/lbug/pool-adapter.js';

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
