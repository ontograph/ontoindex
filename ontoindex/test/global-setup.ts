/**
 * Vitest globalSetup — runs once in the MAIN process before any forks.
 *
 * Creates a single shared LadybugDB with full schema so that forked test
 * files only need to clear + reseed data instead of recreating the
 * entire schema each time (~29 DDL queries per file eliminated).
 *
 * The dbPath is shared with test files via vitest's provide/inject API.
 */
import path from 'path';
import lbug from '@ladybugdb/core';
import type { GlobalSetupContext } from 'vitest/node';
import { createTempDir } from './helpers/test-db.js';
import { resolveLocalLbugExtensionPath } from '../src/core/lbug/lbug-adapter.js';
import { isUnavailableExtension } from '../src/core/lbug/pool-adapter.js';
import {
  NODE_SCHEMA_QUERIES,
  REL_SCHEMA_QUERIES,
  EMBEDDING_SCHEMA,
} from '../src/core/lbug/schema.js';

export default async function setup({ provide }: GlobalSetupContext) {
  const timeoutMs = Number(process.env.ONTOINDEX_TEST_FTS_SETUP_TIMEOUT_MS ?? '10000');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      'ONTOINDEX_TEST_FTS_SETUP_TIMEOUT_MS must be a positive integer in milliseconds.',
    );
  }

  const tmpHandle = await createTempDir('ontoindex-shared-');
  const dbPath = path.join(tmpHandle.dbPath, 'lbug');
  let db: lbug.Database | undefined;
  let conn: lbug.Connection | undefined;
  const errors: unknown[] = [];

  try {
    db = new lbug.Database(dbPath);
    conn = new lbug.Connection(db);
    // Native timeout rejects only after the query settles; never race close against it.
    conn.setQueryTimeout(timeoutMs);
    const runStatement = async (statement: string) => {
      const result = await conn!.query(statement);
      const closeErrors: unknown[] = [];
      for (const item of Array.isArray(result) ? result : [result]) {
        try {
          await item.close();
        } catch (error) {
          closeErrors.push(error);
        }
      }
      if (closeErrors.length === 1) throw closeErrors[0];
      if (closeErrors.length)
        throw new AggregateError(closeErrors, 'Failed to close setup query results.');
    };

    for (const q of [...NODE_SCHEMA_QUERIES, ...REL_SCHEMA_QUERIES, EMBEDDING_SCHEMA]) {
      await runStatement(q);
    }

    // Reuse the offline cache resolver; global setup never downloads extensions.
    const localFtsPath = await resolveLocalLbugExtensionPath('fts');
    try {
      let loaded = false;
      if (localFtsPath) {
        try {
          await runStatement(`LOAD EXTENSION '${localFtsPath.replace(/'/g, "\\'")}'`);
          loaded = true;
        } catch (error) {
          if (!isUnavailableExtension(error)) throw error;
        }
      }
      if (!loaded) await runStatement('LOAD EXTENSION fts');
    } catch (error) {
      if (!isUnavailableExtension(error)) throw error;
      console.warn(
        'OntoIndex test setup: optional FTS unavailable; network installation is disabled. ' +
          'FTS-required acceptance needs a local libfts.lbug_extension via ONTOINDEX_LADYBUG_EXTENSION_DIR.',
        error,
      );
    }
  } catch (error) {
    errors.push(error);
  } finally {
    for (const resource of [conn, db]) {
      try {
        await resource?.close();
      } catch (error) {
        errors.push(error);
      }
    }
  }

  if (errors.length === 0) {
    try {
      provide('lbugDbPath', dbPath);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    try {
      await tmpHandle.cleanup();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(
      errors,
      'LadybugDB global setup failed; inspect the query and cleanup errors.',
      {
        cause: errors[0],
      },
    );
  }

  // Teardown: remove temp directory after all tests complete
  return async () => {
    await tmpHandle.cleanup();
  };
}
