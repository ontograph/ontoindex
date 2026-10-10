import lbug from '@ladybugdb/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  closeBridgeDb,
  ensureBridgeSchema,
  openBridgeDb,
  queryBridge,
} from '../../../src/core/group/bridge-db.js';

describe('bridge-db native QueryResult cleanup', () => {
  let tmpDir: string;
  let closeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-db-close-'));
    closeSpy = vi.spyOn(lbug.QueryResult.prototype, 'close');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('closes schema, query, and execute results while returning rows', async () => {
    const handle = await openBridgeDb(path.join(tmpDir, 'test.lbug'));

    await ensureBridgeSchema(handle);
    expect(closeSpy).toHaveBeenCalled();
    const schemaCloses = closeSpy.mock.calls.length;

    const plainRows = await queryBridge<{ repo: string }>(
      handle,
      "CREATE (c:Contract { id: 'contract-1', repo: 'backend' }) RETURN c.repo AS repo",
    );
    expect(plainRows).toEqual([{ repo: 'backend' }]);
    expect(closeSpy).toHaveBeenCalledTimes(schemaCloses + 1);

    const parameterizedRows = await queryBridge<{ repo: string }>(
      handle,
      'MATCH (c:Contract) WHERE c.repo = $repo RETURN c.repo AS repo',
      { repo: 'backend' },
    );
    expect(parameterizedRows).toEqual([{ repo: 'backend' }]);
    expect(closeSpy).toHaveBeenCalledTimes(schemaCloses + 2);

    await closeBridgeDb(handle);
  });

  it('closes a result after getAll rejects', async () => {
    const handle = await openBridgeDb(path.join(tmpDir, 'test.lbug'));
    await ensureBridgeSchema(handle);
    const closesBeforeQuery = closeSpy.mock.calls.length;
    const getAllSpy = vi
      .spyOn(lbug.QueryResult.prototype, 'getAll')
      .mockRejectedValueOnce(new Error('getAll failed'));

    await expect(queryBridge(handle, 'MATCH (c:Contract) RETURN c')).rejects.toThrow(
      'getAll failed',
    );
    expect(getAllSpy).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(closesBeforeQuery + 1));

    await closeBridgeDb(handle);
  });
});
