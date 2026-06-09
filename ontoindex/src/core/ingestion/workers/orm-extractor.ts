/**
 * ORM query extraction helpers extracted from parse-worker.ts.
 * Regex-based detection for Prisma and Supabase query calls.
 */

import {
  buildPrismaQueryRegex,
  buildSupabaseQueryRegex,
  resolveORMClientIdentifiers,
  type ORMClientIdentifierOptions,
} from '../orm-query-patterns.js';

// ============================================================================
// Public types
// ============================================================================

interface ExtractedORMQuery {
  filePath: string;
  orm: 'prisma' | 'supabase';
  model: string;
  method: string;
  lineNumber: number;
}

/**
 * Extract ORM query calls from file content via regex.
 * Appends results to the provided array (avoids allocation when no matches).
 */
export function extractORMQueries(
  filePath: string,
  content: string,
  out: ExtractedORMQuery[],
  options?: ORMClientIdentifierOptions,
): void {
  const identifiers = resolveORMClientIdentifiers(options);
  const hasPrisma = identifiers.prismaClientIdentifiers.some((identifier) =>
    content.includes(`${identifier}.`),
  );
  const hasSupabase = identifiers.supabaseClientIdentifiers.some((identifier) =>
    content.includes(`${identifier}.from`),
  );
  if (!hasPrisma && !hasSupabase) return;

  if (hasPrisma) {
    const prismaQueryRe = buildPrismaQueryRegex(identifiers.prismaClientIdentifiers);
    prismaQueryRe.lastIndex = 0;
    let m;
    while ((m = prismaQueryRe.exec(content)) !== null) {
      const model = m[1];
      if (model.startsWith('$')) continue;
      out.push({
        filePath,
        orm: 'prisma',
        model,
        method: m[2],
        lineNumber: content.substring(0, m.index).split('\n').length - 1,
      });
    }
  }

  if (hasSupabase) {
    const supabaseQueryRe = buildSupabaseQueryRegex(identifiers.supabaseClientIdentifiers);
    supabaseQueryRe.lastIndex = 0;
    let m;
    while ((m = supabaseQueryRe.exec(content)) !== null) {
      out.push({
        filePath,
        orm: 'supabase',
        model: m[1],
        method: m[2],
        lineNumber: content.substring(0, m.index).split('\n').length - 1,
      });
    }
  }
}
