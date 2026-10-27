import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyLbugOpenError, LbugOpenError } from '../../src/core/lbug/open-error.js';

const mocks = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  construct: vi.fn(),
  close: vi.fn(async () => {}),
  releasePin: vi.fn(async () => {}),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  acquireIndexGenerationPin: async () => ({
    dbPath: '/resolved/lbug',
    release: mocks.releasePin,
  }),
}));
vi.mock('fs/promises', () => ({
  default: {
    stat: async () => ({ ino: 1, size: 1, mtimeMs: 1 }),
    realpath: async (dbPath: string) => dbPath,
  },
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  resolveLocalLbugExtensionPath: async () => null,
}));
vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: class {
      constructor() {
        mocks.construct();
      }
      init = mocks.init;
      close = mocks.close;
    },
    Connection: class {
      query = async () => ({ getAll: async () => [], close: async () => {} });
      close = async () => {};
    },
  },
}));

describe('native open classification', () => {
  it.each([
    ['Could not set lock', 'lock'],
    ['database lock held; unrelated corrupt diagnostic', 'lock'],
    ['resource temporarily unavailable', 'lock'],
    ['EAGAIN', 'lock'],
    ['EWOULDBLOCK', 'lock'],
    ['ENOMEM', 'resource'],
    ['EMFILE: too many open files', 'resource'],
    ['ENFILE', 'resource'],
    ['allocation failed', 'resource'],
    ['out of memory', 'resource'],
    ['EACCES: permission denied', 'permission'],
    ['EPERM', 'permission'],
    ['corrupt database', 'corrupt'],
    ['checksum mismatch', 'corrupt'],
    ['truncated file', 'corrupt'],
    ['malformed database', 'corrupt'],
    ['invalid database file', 'corrupt'],
    ['storage version differs', 'incompatible'],
    ['incompatible database', 'incompatible'],
    ['unsupported version', 'incompatible'],
    ['version mismatch', 'incompatible'],
    ['native open failed', 'unknown'],
    ['WAL replay failed', 'unknown'],
    ['permission denied without a diagnostic code', 'unknown'],
  ])('classifies %s as %s', (message, kind) => {
    expect(classifyLbugOpenError(new Error(message))).toBe(kind);
    expect(classifyLbugOpenError(message)).toBe(kind);
  });

  it('reads system error codes without requiring them in the message', () => {
    expect(classifyLbugOpenError(Object.assign(new Error('open failed'), { code: 'EACCES' }))).toBe(
      'permission',
    );
    expect(classifyLbugOpenError(null)).toBe('unknown');
  });
});

describe('typed pool open failures', () => {
  let pool: typeof import('../../src/core/lbug/pool-adapter.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    pool = await import('../../src/core/lbug/pool-adapter.js');
  });

  afterEach(async () => {
    await pool.closeLbug();
  });

  it('preserves the original init error and resolved path', async () => {
    const cause = new Error('EACCES: native initialization failed');
    mocks.init.mockRejectedValueOnce(cause);
    const error = await pool.initLbug('open-error', '/alias/lbug').catch((failure) => failure);
    expect(error).toBeInstanceOf(LbugOpenError);
    expect(error).toMatchObject({
      phase: 'native-open',
      dbPath: '/resolved/lbug',
      kind: 'permission',
      cause,
      message: cause.message,
    });
  });

  it('replays the typed cached error without another native open', async () => {
    const cause = new Error('native open failed');
    mocks.init.mockRejectedValueOnce(cause);
    const first = await pool.initLbug('first-open', '/alias/lbug').catch((failure) => failure);
    const cached = await pool.initLbug('cached-open', '/alias/lbug').catch((failure) => failure);
    expect(cached).toBeInstanceOf(LbugOpenError);
    expect(first).toBeInstanceOf(LbugOpenError);
    expect(cached).toMatchObject({
      phase: 'native-open',
      dbPath: '/resolved/lbug',
      kind: 'unknown',
      cause,
    });
    expect(cached.message).toContain('native initialization failed');
    expect(cached.message).toContain(cause.message);
    expect(mocks.construct).toHaveBeenCalledTimes(1);
  });

  it('wraps native constructor failures with their original cause', async () => {
    const cause = new Error('ENOMEM: allocation failed');
    mocks.construct.mockImplementationOnce(() => {
      throw cause;
    });
    const error = await pool.initLbug('construct-error', '/alias/lbug').catch((failure) => failure);
    expect(error).toBeInstanceOf(LbugOpenError);
    expect(error).toMatchObject({
      phase: 'native-open',
      dbPath: '/resolved/lbug',
      kind: 'resource',
      cause,
    });
    expect(error.message).toContain(cause.message);
  });
});
