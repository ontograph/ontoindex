/**
 * Index Store Port Interface
 *
 * Defines the contract for persistence and retrieval of the code graph.
 * Decouples graph logic from the underlying storage engine (LadybugDB, DuckDB, etc).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// LbugValue used to be imported from @ladybugdb/core; shared keeps a local value union
// to avoid circular dependency or external deps in shared if possible.
// Or we can define a minimal LbugValue type here.

export type LbugValue = string | number | boolean | null | string[] | number[] | boolean[];

export interface IndexStore {
  /**
   * Execute a Cypher query and return materialized results.
   */
  executeQuery(cypher: string): Promise<unknown[]>;

  /**
   * Execute a parameterized Cypher query.
   */
  executeParameterized(cypher: string, params: Record<string, LbugValue>): Promise<unknown[]>;

  /**
   * Execute a batch of queries with reused statement (for bulk insertion).
   */
  executeBatch(cypher: string, paramsList: Array<Record<string, LbugValue>>): Promise<void>;

  /**
   * Stream results row-by-row to handle large result sets with constant memory.
   */
  streamQuery(cypher: string, onRow: (row: unknown) => void | Promise<void>): Promise<number>;

  /**
   * Flush pending writes and close the store handle.
   */
  close(): Promise<void>;
}
