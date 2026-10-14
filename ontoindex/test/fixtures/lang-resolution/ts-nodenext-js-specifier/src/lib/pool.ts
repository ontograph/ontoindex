export const POOL_SIZE = 4;

export const runQuery = async (sql: string): Promise<string> => sql;

export function isWrite(sql: string): boolean {
  return sql.startsWith('CREATE');
}
