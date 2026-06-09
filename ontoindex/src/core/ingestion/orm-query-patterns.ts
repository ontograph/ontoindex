const DEFAULT_PRISMA_CLIENT_IDENTIFIERS = ['prisma'];
const DEFAULT_SUPABASE_CLIENT_IDENTIFIERS = ['supabase'];

export interface ORMClientIdentifierOptions {
  prismaClientIdentifiers?: readonly string[];
  supabaseClientIdentifiers?: readonly string[];
}

interface ResolvedORMClientIdentifiers {
  prismaClientIdentifiers: string[];
  supabaseClientIdentifiers: string[];
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeIdentifiers(
  identifiers: readonly string[] | undefined,
  defaults: readonly string[],
): string[] {
  const seen = new Set<string>();
  for (const identifier of [...defaults, ...(identifiers ?? [])]) {
    const trimmed = identifier.trim();
    if (trimmed.length === 0) continue;
    seen.add(trimmed);
  }
  return [...seen];
}

export function resolveORMClientIdentifiers(
  options?: ORMClientIdentifierOptions,
): ResolvedORMClientIdentifiers {
  return {
    prismaClientIdentifiers: normalizeIdentifiers(
      options?.prismaClientIdentifiers,
      DEFAULT_PRISMA_CLIENT_IDENTIFIERS,
    ),
    supabaseClientIdentifiers: normalizeIdentifiers(
      options?.supabaseClientIdentifiers,
      DEFAULT_SUPABASE_CLIENT_IDENTIFIERS,
    ),
  };
}

export function buildPrismaQueryRegex(clientIdentifiers: readonly string[]): RegExp {
  const ids = clientIdentifiers.map((identifier) => escapeRegex(identifier)).join('|');
  return new RegExp(
    `\\b(?:${ids})\\.(\\w+)\\.(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|create|createMany|update|updateMany|delete|deleteMany|upsert|count|aggregate|groupBy)\\s*\\(`,
    'g',
  );
}

export function buildSupabaseQueryRegex(clientIdentifiers: readonly string[]): RegExp {
  const ids = clientIdentifiers.map((identifier) => escapeRegex(identifier)).join('|');
  return new RegExp(
    `\\b(?:${ids})\\.from\\s*\\(\\s*['"](\\w+)['"]\\s*\\)\\s*\\.(select|insert|update|delete|upsert)\\s*\\(`,
    'g',
  );
}
