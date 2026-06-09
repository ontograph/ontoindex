# ADR-0008: Frontend summary mode for huge graphs

**Status:** Accepted
**Date:** 2026-04-30 (perf-stability + Wave 1.5 fix)
**Source:** `ontoindex/src/server/api.ts` (server side); `ontoindex-web/src/services/backend-client.ts`, `hooks/useAppState.tsx`, `hooks/useSigma.ts`, `App.tsx`, `components/StatusBar.tsx`, `lib/constants.ts` (client side).

## Context

The web client renders the full graph using Sigma.js + graphology. For repos with 5000+ nodes, the initial download + layout takes minutes. Most user interactions on huge graphs (vscode, kubernetes) are at coarse granularity — Folder/File/Module/Process — not at function/class detail. Loading detail nodes the user can't perceive is wasted bandwidth.

## Decision

Auto-select **summary mode** (Folder + File + Community + Process + Module nodes only; CONTAINS + IMPORTS edges only) for repos with `nodes > 5000`. Auto-skip layout computation for `nodes >= 3000`. Provide `?full=true` URL escape hatch for power users. Show a **Summary badge** in StatusBar when active. Server constrains both endpoints of summary relationships to summary node labels (Wave 1.5 fix-4: prevents dangling rels).

## Algorithm / Technique

### Thresholds (`constants.ts`)

```
export const HUGE_GRAPH_THRESHOLD = 5000;   // auto-select summary mode above this
export const AUTO_LAYOUT_THRESHOLD = 3000;  // skip layout above this
```

These are independent: a 4000-node graph gets full detail but skips layout (user can drag-position); a 6000-node graph gets summary AND skips layout.

### Connection-time decision (`backend-client.ts:connectToServer`)

```
function connectToServer(serverUrl, opts?: { forceFull?: boolean }): Promise<ConnectResult> {
  const repoInfo = await fetch(`${serverUrl}/api/repo`);
  const nodeCount = repoInfo.stats?.nodes ?? 0;
  const isHuge = nodeCount > HUGE_GRAPH_THRESHOLD && !opts?.forceFull;

  const graph = await fetchGraph(serverUrl, { summary: isHuge });

  return { graph, isSummary: isHuge, ...repoInfo };
}
```

`isSummary` is determined at connection time based on the repo's stats from `/api/repo`. The `forceFull` flag overrides the auto-decision.

### URL escape hatch (`App.tsx`)

```
const params = new URLSearchParams(window.location.search);
const fullParam = params.get('full') === 'true';

// On initial load:
connectToServer(serverUrl, { forceFull: fullParam });
```

`?full=true` lets the user opt out of summary mode for a specific session. Case-sensitive (`'true'` exactly); `?full=True` is silently treated as false (URL convention is lowercase; documented in §6 of forward plan).

### Server-side summary mode (`api.ts:buildGraph` + `streamGraphNdjson`, Wave 1.5 fix-4)

```
const SUMMARY_NODE_TABLES = ['Folder', 'File', 'Community', 'Process', 'Module'];
const SUMMARY_REL_TYPES = ['CONTAINS', 'IMPORTS'];

if (summary) {
  // Node query: only summary node labels
  const nodeRows = await executeQuery(`
    MATCH (n)
    WHERE n.label IN ${JSON.stringify(SUMMARY_NODE_TABLES)}
    RETURN n
  `);

  // Relationship query: type filter + label constraints on BOTH endpoints
  const relRows = await executeQuery(`
    MATCH (a)-[r:CodeRelation]->(b)
    WHERE r.type IN ${JSON.stringify(SUMMARY_REL_TYPES)}
      AND a.label IN ${JSON.stringify(SUMMARY_NODE_TABLES)}
      AND b.label IN ${JSON.stringify(SUMMARY_NODE_TABLES)}
    RETURN ...
  `);
}
```

Pre-Wave-1.5 the relationship query lacked the label constraints — `CONTAINS` edges from Function/Class/Scope/Section nodes flowed into the result, producing dangling rels (sourceId/targetId not in the node list). The Wave 1.5 fix adds both-endpoint constraints; the client now sees only relationships whose endpoints are also in the result.

### Client state propagation (`useAppState.tsx`)

```
const [isSummary, setIsSummary] = useState(false);

const loadRepo = async (serverUrl, opts) => {
  try {
    const result = await connectToServer(serverUrl, opts);
    setGraph(result.graph);
    setIsSummary(result.isSummary);  // honor server's verdict
  } catch (err) {
    setIsSummary(false);  // Wave 1.5 minor-fix-5: reset on error to avoid stale badge
    setIsAgentReady(false);
  }
};
```

`isSummary` propagates through context so any component (`StatusBar`, sidebars, etc.) can read it.

### Layout gate (`useSigma.ts`)

```
useEffect(() => {
  if (newGraph.order < AUTO_LAYOUT_THRESHOLD) {
    runForceAtlas2Layout(newGraph);
  } else {
    // Skip — user can drag or use random positions
    applyRandomPositions(newGraph);
  }
}, [newGraph]);
```

`order` is graphology's node count. Strict less-than: at exactly 3000, layout is skipped (conservative).

### Summary badge (`StatusBar.tsx`)

```
{isSummary && (
  <span className="summary-badge">Summary</span>
)}
```

Visible cue that this is a reduced graph. User can manually load `?full=true` if they want detail.

### Why these label sets

- **Summary nodes:** Folder + File + Community + Module + Process. These are containers and clusters — they answer "what's in this repo at a high level?" Function/Class/Scope nodes are excluded because they're per-symbol detail.
- **Summary rels:** CONTAINS (containment hierarchy) + IMPORTS (file-level dependencies). CALLS edges are excluded because they're per-function detail; STEP_IN_PROCESS is excluded because it's per-step detail within a Process.

These choices are pragmatic — what an architecture-level UI needs to render usefully.

## Consequences

**Positive:**
- Repos with 5000+ nodes load and render usefully (no minute-long stalls)
- `?full=true` escape hatch preserves power-user workflow
- Layout skip prevents the heaviest CPU cost on the largest graphs
- Both-endpoint label constraint prevents dangling relationships

**Negative:**
- Hard-coded thresholds (5000, 3000) — not configurable per user/repo
- Summary badge is the only feedback; no tooltip explaining "click `?full=true` for detail"
- `?full=true` is case-sensitive (URL convention but undocumented)
- isSummary not reset on connect-error path (Wave 1.5 minor-fix-5 added the reset)

**Open issues for future work:**
- Configurable thresholds via user preference
- Tooltip on Summary badge: "showing X of Y nodes (?full=true for all)"
- Adaptive thresholds based on client device performance
- Progressive detail loading (start with summary; lazy-load details on zoom)
