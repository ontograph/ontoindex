/**
 * Route domain module — intent-based tool routing.
 *
 * Provides a classifier that maps natural language queries to the
 * most appropriate OntoIndex tool (query, context, impact, or repomap).
 */

// Local RepoHandle alias — ./backend-types.js exists on bundle/mcp-tools-split
// but not on main's flat backend. Only the id is referenced (and via _ here).
type RepoHandle = { readonly id: string };

type RouteToolResult =
  | {
      tool: 'context' | 'impact' | 'query' | 'repomap';
      reason: string;
      suggestion: string;
    }
  | { error: 'Routing failed' };

/** Structured error logging for routing failures */
function logQueryError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`OntoIndex [${context}]: ${msg}`);
}

/**
 * Route tool — keyword-based intent heuristic.
 *
 * Maps natural language to the best tool recommendation.
 */
export async function routeTool(
  _repo: RepoHandle,
  params: { query: string },
): Promise<RouteToolResult> {
  const q = params.query.toLowerCase();

  try {
    // T-1.2.03 heuristic v0
    if (q.includes('what calls') || q.includes('who calls') || q.includes('callers of')) {
      return {
        tool: 'context',
        reason: 'You asked about callers/dependencies of a specific symbol.',
        suggestion:
          'Use context({name: "<symbol_name>"}) to see all categorized incoming and outgoing relationships.',
      };
    }

    if (
      q.includes('break') ||
      q.includes('safe to change') ||
      q.includes('what breaks') ||
      q.includes('impact')
    ) {
      return {
        tool: 'impact',
        reason: 'You asked about the consequences or blast radius of a change.',
        suggestion:
          'Use impact({target: "<symbol_name>", direction: "upstream"}) to find all symbols that will break if this one changes.',
      };
    }

    if (
      q.includes('how does') ||
      q.includes('how works') ||
      q.includes('architecture') ||
      q.includes('flow')
    ) {
      return {
        tool: 'query',
        reason: 'You asked about high-level architecture or execution flows.',
        suggestion:
          'Use query({query: "' +
          params.query +
          '"}) to find ranked execution flows (call chains) related to this concept.',
      };
    }

    if (
      q.includes('show me the files') ||
      q.includes('structure') ||
      q.includes('overview of the repo')
    ) {
      return {
        tool: 'repomap',
        reason: 'You asked for a high-level map or structural overview of the files.',
        suggestion:
          'Use repomap({focus: [], format: "compressed"}) to get a token-efficient summary of the most important symbols.',
      };
    }

    // Default
    return {
      tool: 'query',
      reason: 'Standard conceptual search.',
      suggestion:
        'Use query({query: "' + params.query + '"}) to find relevant execution flows and symbols.',
    };
  } catch (err) {
    logQueryError('route', err);
    return { error: 'Routing failed' };
  }
}
