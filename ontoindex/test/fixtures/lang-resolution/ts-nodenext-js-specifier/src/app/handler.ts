import {
  isWrite,
  runQuery,
} from '../lib/pool.js';

export async function handle(sql: string): Promise<string> {
  if (isWrite(sql)) throw new Error('read only');
  return runQuery(sql);
}
