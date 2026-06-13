import type { GraphNode, GraphRelationship } from 'ontoindex-shared';

export interface GraphHtmlExportProvenance {
  repoId: string;
  repoPath: string;
  generatedAt: string;
  indexedAt: string | null;
  indexedHead: string | null;
  summary: boolean;
}

export interface GraphHtmlSliceOption {
  id: string;
  label: string;
  count: number;
}

export interface GraphHtmlPayloadNode {
  id: string;
  label: string;
  name: string;
  filePath?: string;
  areaIds: string[];
  processIds: string[];
  communityIds: string[];
}

export interface GraphHtmlPayloadRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
}

export interface GraphHtmlPayload {
  provenance: GraphHtmlExportProvenance;
  counts: {
    nodes: number;
    relationships: number;
  };
  nodes: GraphHtmlPayloadNode[];
  relationships: GraphHtmlPayloadRelationship[];
  slices: {
    processes: GraphHtmlSliceOption[];
    communities: GraphHtmlSliceOption[];
    areas: GraphHtmlSliceOption[];
    nodeLabels: GraphHtmlSliceOption[];
    relationshipTypes: GraphHtmlSliceOption[];
    anchors: GraphHtmlSliceOption[];
  };
}

function normalizeName(node: GraphNode): string {
  const raw = node.properties.name;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  if (typeof node.id === 'string' && node.id.trim().length > 0) return node.id;
  return node.label;
}

function normalizeFilePath(node: GraphNode): string | undefined {
  return typeof node.properties.filePath === 'string' && node.properties.filePath.trim().length > 0
    ? node.properties.filePath
    : undefined;
}

function createAreaId(filePath: string | undefined): string | null {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  return segments.length === 1 ? segments[0] : segments[0];
}

function labelForNode(node: GraphNode): string {
  if (node.label === 'Process' || node.label === 'Community') {
    const heuristic = node.properties.heuristicLabel;
    if (typeof heuristic === 'string' && heuristic.trim().length > 0) return heuristic;
  }
  return normalizeName(node);
}

function sortSliceOptions(options: Iterable<GraphHtmlSliceOption>): GraphHtmlSliceOption[] {
  return Array.from(options).sort((a, b) => {
    const byLabel = a.label.localeCompare(b.label);
    if (byLabel !== 0) return byLabel;
    return a.id.localeCompare(b.id);
  });
}

function escapeScript(text: string): string {
  return text.replace(/<\//g, '<\\/');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildGraphHtmlPayload(
  graph: { nodes: GraphNode[]; relationships: GraphRelationship[] },
  provenance: GraphHtmlExportProvenance,
): GraphHtmlPayload {
  const labelCounts = new Map<string, number>();
  const relationshipTypeCounts = new Map<string, number>();
  const areaCounts = new Map<string, number>();
  const processOptionMap = new Map<string, GraphHtmlSliceOption>();
  const communityOptionMap = new Map<string, GraphHtmlSliceOption>();

  const processIdsByNode = new Map<string, Set<string>>();
  const communityIdsByNode = new Map<string, Set<string>>();
  const areaIdsByNode = new Map<string, Set<string>>();
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  for (const node of graph.nodes) {
    labelCounts.set(node.label, (labelCounts.get(node.label) ?? 0) + 1);

    const areaId = createAreaId(normalizeFilePath(node));
    if (areaId) {
      if (!areaIdsByNode.has(node.id)) areaIdsByNode.set(node.id, new Set<string>());
      areaIdsByNode.get(node.id)!.add(areaId);
    }

    if (node.label === 'Process') {
      processOptionMap.set(node.id, { id: node.id, label: labelForNode(node), count: 0 });
      if (!processIdsByNode.has(node.id)) processIdsByNode.set(node.id, new Set<string>());
      processIdsByNode.get(node.id)!.add(node.id);
    }

    if (node.label === 'Community') {
      communityOptionMap.set(node.id, { id: node.id, label: labelForNode(node), count: 0 });
      if (!communityIdsByNode.has(node.id)) communityIdsByNode.set(node.id, new Set<string>());
      communityIdsByNode.get(node.id)!.add(node.id);
    }
  }

  for (const relationship of graph.relationships) {
    relationshipTypeCounts.set(
      relationship.type,
      (relationshipTypeCounts.get(relationship.type) ?? 0) + 1,
    );

    if (relationship.type === 'STEP_IN_PROCESS' && nodeById.has(relationship.targetId)) {
      const processId = relationship.targetId;
      if (!processIdsByNode.has(relationship.sourceId)) {
        processIdsByNode.set(relationship.sourceId, new Set<string>());
      }
      processIdsByNode.get(relationship.sourceId)!.add(processId);
      const option = processOptionMap.get(processId);
      if (option) option.count += 1;

      const sourceAreas = areaIdsByNode.get(relationship.sourceId);
      if (sourceAreas && sourceAreas.size > 0) {
        if (!areaIdsByNode.has(processId)) areaIdsByNode.set(processId, new Set<string>());
        for (const areaId of sourceAreas) areaIdsByNode.get(processId)!.add(areaId);
      }
    }

    if (relationship.type === 'MEMBER_OF' && nodeById.has(relationship.targetId)) {
      const communityId = relationship.targetId;
      if (!communityIdsByNode.has(relationship.sourceId)) {
        communityIdsByNode.set(relationship.sourceId, new Set<string>());
      }
      communityIdsByNode.get(relationship.sourceId)!.add(communityId);
      const option = communityOptionMap.get(communityId);
      if (option) option.count += 1;

      const sourceAreas = areaIdsByNode.get(relationship.sourceId);
      if (sourceAreas && sourceAreas.size > 0) {
        if (!areaIdsByNode.has(communityId)) areaIdsByNode.set(communityId, new Set<string>());
        for (const areaId of sourceAreas) areaIdsByNode.get(communityId)!.add(areaId);
      }
    }
  }

  const payloadNodes = graph.nodes
    .map((node): GraphHtmlPayloadNode => {
      const areaIds = Array.from(areaIdsByNode.get(node.id) ?? []).sort();
      for (const areaId of areaIds) areaCounts.set(areaId, (areaCounts.get(areaId) ?? 0) + 1);
      return {
        id: node.id,
        label: node.label,
        name: normalizeName(node),
        filePath: normalizeFilePath(node),
        areaIds,
        processIds: Array.from(processIdsByNode.get(node.id) ?? []).sort(),
        communityIds: Array.from(communityIdsByNode.get(node.id) ?? []).sort(),
      };
    })
    .sort((a, b) => {
      const byLabel = a.label.localeCompare(b.label);
      if (byLabel !== 0) return byLabel;
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return a.id.localeCompare(b.id);
    });

  const payloadRelationships = graph.relationships
    .map((relationship): GraphHtmlPayloadRelationship => ({
      id: relationship.id,
      sourceId: relationship.sourceId,
      targetId: relationship.targetId,
      type: relationship.type,
    }))
    .sort((a, b) => {
      const byType = a.type.localeCompare(b.type);
      if (byType !== 0) return byType;
      const bySource = a.sourceId.localeCompare(b.sourceId);
      if (bySource !== 0) return bySource;
      return a.targetId.localeCompare(b.targetId);
    });

  const areaOptions = sortSliceOptions(
    Array.from(areaCounts.entries(), ([id, count]) => ({ id, label: id, count })),
  );
  const nodeLabelOptions = sortSliceOptions(
    Array.from(labelCounts.entries(), ([id, count]) => ({ id, label: id, count })),
  );
  const relationshipTypeOptions = sortSliceOptions(
    Array.from(relationshipTypeCounts.entries(), ([id, count]) => ({ id, label: id, count })),
  );
  const anchors = payloadNodes.map((node) => ({
    id: node.id,
    label: `${node.name} (${node.label})`,
    count: 1,
  }));

  return {
    provenance,
    counts: {
      nodes: payloadNodes.length,
      relationships: payloadRelationships.length,
    },
    nodes: payloadNodes,
    relationships: payloadRelationships,
    slices: {
      processes: sortSliceOptions(processOptionMap.values()),
      communities: sortSliceOptions(communityOptionMap.values()),
      areas: areaOptions,
      nodeLabels: nodeLabelOptions,
      relationshipTypes: relationshipTypeOptions,
      anchors: sortSliceOptions(anchors),
    },
  };
}

function formatShortDate(value: string | null): string {
  if (!value) return 'unknown';
  try {
    return new Date(value).toLocaleDateString('en-US', { dateStyle: 'medium' });
  } catch {
    return value;
  }
}

export function renderGraphOverviewHtml(payload: GraphHtmlPayload): string {
  const payloadJson = escapeScript(JSON.stringify(payload));
  const title = `${escapeHtml(payload.provenance.repoId)} Graph Overview`;
  const shortHead = payload.provenance.indexedHead
    ? escapeHtml(payload.provenance.indexedHead.slice(0, 8))
    : 'unknown';
  const indexedAt = escapeHtml(formatShortDate(payload.provenance.indexedAt));
  const generatedAt = escapeHtml(formatShortDate(payload.provenance.generatedAt));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    :root {
      --bg: #f6f8fc;
      --panel: #ffffff;
      --border: #d7dce5;
      --text: #18202a;
      --muted: #5d6a7c;
      --accent: #1d4ed8;
      --accent-soft: #dbeafe;
      --edge: rgba(70, 88, 116, 0.22);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background: var(--bg);
    }
    .layout {
      display: grid;
      grid-template-columns: 390px minmax(0, 1fr);
      min-height: 100vh;
    }
    .sidebar {
      padding: 20px;
      border-right: 1px solid var(--border);
      background: var(--panel);
      overflow-y: auto;
    }
    .content {
      padding: 20px;
      min-width: 0;
    }
    h1 {
      font-size: 24px;
      margin: 0 0 8px;
    }
    .subtitle, .meta, .hint, .summary-copy, .help-list, .field-help {
      color: var(--muted);
      line-height: 1.55;
    }
    .subtitle {
      font-size: 14px;
    }
    .summary-copy {
      margin-top: 10px;
      font-size: 13px;
    }
    .meta {
      margin: 12px 0 16px;
      font-size: 12px;
    }
    .hero-stats, .inline-metric {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .hero-stat, .metric {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      padding: 12px;
    }
    .hero-stat {
      background: #fbfdff;
    }
    .hero-stat-label, .metric-label {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .hero-stat-value {
      font-size: 18px;
      font-weight: 700;
      margin-top: 4px;
    }
    .metric-value {
      font-size: 22px;
      font-weight: 700;
      margin-top: 6px;
    }
    details.meta-block {
      margin-top: 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #fbfdff;
      padding: 10px 12px;
    }
    details.meta-block summary {
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
    }
    .meta-grid {
      display: grid;
      gap: 6px;
      margin-top: 10px;
      font-size: 12px;
      color: var(--muted);
    }
    .panel {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      margin-top: 14px;
      overflow: hidden;
    }
    .panel h2 {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin: 0;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      background: #f9fbff;
    }
    .panel-body {
      padding: 14px;
    }
    .help-list {
      margin: 0;
      padding-left: 18px;
      font-size: 12px;
    }
    .help-list li {
      margin-bottom: 8px;
    }
    .preset-row, .action-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .preset-row {
      margin-bottom: 12px;
    }
    button.preset, button.action {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #fff;
      color: var(--text);
      padding: 7px 10px;
      font-size: 12px;
      cursor: pointer;
    }
    button.preset:hover, button.action:hover {
      background: var(--accent-soft);
      border-color: #bfd3ff;
    }
    .field {
      margin-bottom: 14px;
    }
    label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    select, input[type="range"], input[type="search"] {
      width: 100%;
    }
    input[type="search"] {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      background: #fff;
      color: var(--text);
      margin-bottom: 8px;
    }
    select {
      min-height: 92px;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px;
      background: #fff;
      color: var(--text);
    }
    input[type="range"] {
      margin-top: 8px;
    }
    .field-help {
      margin-top: 6px;
      font-size: 11px;
    }
    .graph-shell {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      overflow: hidden;
      margin-top: 14px;
    }
    .graph-toolbar {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      background: #f9fbff;
      font-size: 12px;
    }
    .graph-canvas {
      width: 100%;
      height: 72vh;
      display: block;
      background: linear-gradient(180deg, #fcfdff 0%, #f5f7fb 100%);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 4px 8px;
      background: #fff;
      color: var(--muted);
      font-size: 11px;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .node-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      font-size: 12px;
    }
    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      flex: 0 0 auto;
    }
    .inspector {
      display: grid;
      gap: 6px;
      font-size: 12px;
    }
    .empty {
      color: var(--muted);
      font-size: 13px;
      padding: 24px;
      text-align: center;
    }
    @media (max-width: 1100px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .sidebar {
        border-right: none;
        border-bottom: 1px solid var(--border);
      }
      .graph-canvas {
        height: 60vh;
      }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <h1>${title}</h1>
      <div class="subtitle">Interactive architecture graph for modules, execution flows, and functional areas.</div>
      <div class="summary-copy">
        Start with a preset, then narrow the graph by flow, area, or node type. Click any node to focus its neighborhood and inspect where it belongs.
      </div>
      <div class="hero-stats">
        <div class="hero-stat">
          <div class="hero-stat-label">Nodes</div>
          <div class="hero-stat-value">${payload.counts.nodes}</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-label">Edges</div>
          <div class="hero-stat-value">${payload.counts.relationships}</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-label">Scope</div>
          <div class="hero-stat-value">${payload.provenance.summary ? 'Summary' : 'Full'}</div>
        </div>
      </div>
      <div class="meta">Indexed ${indexedAt} · Head ${shortHead} · Generated ${generatedAt}</div>
      <details class="meta-block">
        <summary>Technical metadata</summary>
        <div class="meta-grid">
          <div>Repo path: <code>${escapeHtml(payload.provenance.repoPath)}</code></div>
          <div>Indexed head: <code>${escapeHtml(payload.provenance.indexedHead ?? 'unknown')}</code></div>
          <div>Indexed at: <code>${escapeHtml(payload.provenance.indexedAt ?? 'unknown')}</code></div>
          <div>Generated at: <code>${escapeHtml(payload.provenance.generatedAt)}</code></div>
          <div>Mode: <code>${payload.provenance.summary ? 'summary' : 'full'}</code></div>
        </div>
      </details>

      <div class="panel">
        <h2>How To Read This Graph</h2>
        <div class="panel-body">
          <ul class="help-list">
            <li><strong>Nodes</strong> are files, modules, flows, and other code entities extracted from OntoIndex core data.</li>
            <li><strong>Execution flows</strong> trace symbols that participate in a process.</li>
            <li><strong>Functional areas</strong> come from OntoIndex community detection and show related code regions.</li>
            <li><strong>Focus node + neighborhood depth</strong> isolates the local architecture around one item.</li>
          </ul>
        </div>
      </div>

      <div class="panel">
        <h2>Presets And Reset</h2>
        <div class="panel-body">
          <div class="preset-row">
            <button class="preset" data-preset="overview" type="button">Architecture Overview</button>
            <button class="preset" data-preset="flows" type="button">Execution Flows</button>
            <button class="preset" data-preset="areas" type="button">Functional Areas</button>
            <button class="preset" data-preset="structure" type="button">Files And Modules</button>
          </div>
          <div class="action-row">
            <button class="action" id="reset-filters" type="button">Reset Filters</button>
          </div>
        </div>
      </div>

      <div class="panel">
        <h2>Functional Slices</h2>
        <div class="panel-body">
          <div class="field">
            <label for="process-filter">Execution Flows</label>
            <input id="process-search" type="search" placeholder="Filter execution flows">
            <select id="process-filter" multiple></select>
            <div class="field-help">Show only symbols and files that participate in the selected flow.</div>
          </div>
          <div class="field">
            <label for="community-filter">Functional Areas</label>
            <input id="community-search" type="search" placeholder="Filter functional areas">
            <select id="community-filter" multiple></select>
            <div class="field-help">Areas group code that OntoIndex found to be closely related.</div>
          </div>
          <div class="field">
            <label for="area-filter">Folders / Modules</label>
            <input id="area-search" type="search" placeholder="Filter folders or modules">
            <select id="area-filter" multiple></select>
            <div class="field-help">Use this when you want a structural slice instead of a behavior slice.</div>
          </div>
        </div>
      </div>

      <div class="panel">
        <h2>Graph Filters</h2>
        <div class="panel-body">
          <div class="field">
            <label for="label-filter">Node Types</label>
            <select id="label-filter" multiple></select>
          </div>
          <div class="field">
            <label for="relationship-filter">Relationship Types</label>
            <select id="relationship-filter" multiple></select>
          </div>
          <div class="field">
            <label for="anchor-filter">Focus Node</label>
            <input id="anchor-search" type="search" placeholder="Filter focus-node list">
            <select id="anchor-filter"></select>
            <div class="field-help">Pick a node, then lower or raise neighborhood depth to inspect the local graph.</div>
          </div>
          <div class="field">
            <label for="depth-filter">Neighborhood Depth: <span id="depth-value">2</span></label>
            <input id="depth-filter" type="range" min="1" max="5" value="2">
            <div class="field-help">1 is the immediate neighborhood; higher values broaden the local architecture slice.</div>
          </div>
        </div>
      </div>

      <div class="panel">
        <h2>Legend</h2>
        <div class="panel-body">
          <div class="legend" id="legend"></div>
          <div class="field-help" style="margin-top: 10px;">
            Key relationships: <code>CALLS</code> for execution, <code>CONTAINS</code> for structure,
            <code>MEMBER_OF</code> for functional-area membership, and <code>STEP_IN_PROCESS</code> for flow participation.
          </div>
        </div>
      </div>

      <div class="panel">
        <h2>Selection</h2>
        <div class="panel-body inspector" id="inspector">
          <div class="hint">Click a node to focus it, inspect its memberships, and understand how it fits into the graph.</div>
        </div>
      </div>
    </aside>

    <main class="content">
      <div class="inline-metric">
        <div class="metric">
          <div class="metric-label">Visible Nodes</div>
          <div class="metric-value" id="visible-nodes">0</div>
        </div>
        <div class="metric">
          <div class="metric-label">Visible Edges</div>
          <div class="metric-value" id="visible-edges">0</div>
        </div>
        <div class="metric">
          <div class="metric-label">Slice State</div>
          <div class="metric-value" id="slice-state">All</div>
        </div>
      </div>

      <div class="graph-shell">
        <div class="graph-toolbar">
          <div id="graph-summary">Preparing architecture view…</div>
          <div class="badge">Derived from OntoIndex core graph evidence</div>
        </div>
        <svg id="graph" class="graph-canvas" viewBox="0 0 1280 820" preserveAspectRatio="xMidYMid meet"></svg>
      </div>
    </main>
  </div>

  <script>
    const PAYLOAD = ${payloadJson};
    const COLOR_BY_LABEL = {
      File: '#1d4ed8',
      Folder: '#0f766e',
      Module: '#7c3aed',
      Process: '#c2410c',
      Community: '#059669',
      Function: '#2563eb',
      Method: '#2563eb',
      Class: '#9333ea',
      Interface: '#7c3aed',
      Route: '#b91c1c',
      Tool: '#9a3412'
    };

    const el = (id) => document.getElementById(id);
    const byId = new Map(PAYLOAD.nodes.map((node) => [node.id, node]));
    let selectedNodeId = '';

    function shortName(value) {
      return value.length > 42 ? value.slice(0, 39) + '…' : value;
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function colorForLabel(label) {
      return COLOR_BY_LABEL[label] || '#475569';
    }

    function selectedValues(select) {
      return Array.from(select.selectedOptions).map((option) => option.value).filter(Boolean);
    }

    function setMultiSelectValues(select, values) {
      const wanted = new Set(values);
      for (const option of Array.from(select.options)) {
        option.selected = wanted.has(option.value);
      }
    }

    function fillSelect(select, options, includeBlank) {
      const current = new Set(selectedValues(select));
      select.innerHTML = '';
      if (includeBlank) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'None';
        select.appendChild(option);
      }
      for (const entry of options) {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = includeBlank ? entry.label : entry.label + ' (' + entry.count + ')';
        if (current.has(entry.id)) option.selected = true;
        select.appendChild(option);
      }
    }

    function filterSelectByQuery(select, query) {
      const normalized = query.trim().toLowerCase();
      for (const option of Array.from(select.options)) {
        option.hidden = normalized ? !option.textContent.toLowerCase().includes(normalized) : false;
      }
    }

    function renderLegend() {
      const legend = el('legend');
      legend.innerHTML = '';
      for (const entry of PAYLOAD.slices.nodeLabels) {
        const row = document.createElement('div');
        row.className = 'node-row';
        row.innerHTML =
          '<span class="swatch" style="background:' +
          colorForLabel(entry.id) +
          '"></span><span>' +
          escapeHtml(entry.label) +
          '</span>';
        legend.appendChild(row);
      }
    }

    function matchesFilter(values, selected) {
      if (selected.length === 0) return true;
      return values.some((value) => selected.includes(value));
    }

    function matchesScalar(value, selected) {
      if (selected.length === 0) return true;
      return selected.includes(value);
    }

    function applyDepthFilter(nodeIds, anchorId, depth, relationships) {
      if (!anchorId || !nodeIds.has(anchorId)) return nodeIds;
      const allowed = new Set([anchorId]);
      const queue = [{ id: anchorId, depth: 0 }];
      const adjacency = new Map();

      for (const rel of relationships) {
        if (!nodeIds.has(rel.sourceId) || !nodeIds.has(rel.targetId)) continue;
        if (!adjacency.has(rel.sourceId)) adjacency.set(rel.sourceId, new Set());
        if (!adjacency.has(rel.targetId)) adjacency.set(rel.targetId, new Set());
        adjacency.get(rel.sourceId).add(rel.targetId);
        adjacency.get(rel.targetId).add(rel.sourceId);
      }

      while (queue.length > 0) {
        const current = queue.shift();
        if (current.depth >= depth) continue;
        const neighbors = Array.from(adjacency.get(current.id) || []);
        for (const neighbor of neighbors) {
          if (allowed.has(neighbor)) continue;
          allowed.add(neighbor);
          queue.push({ id: neighbor, depth: current.depth + 1 });
        }
      }

      return allowed;
    }

    function deriveLayout(nodes) {
      const byLabel = new Map();
      for (const node of nodes) {
        if (!byLabel.has(node.label)) byLabel.set(node.label, []);
        byLabel.get(node.label).push(node);
      }
      const labels = Array.from(byLabel.keys()).sort();
      const centerX = 640;
      const centerY = 410;
      const positions = new Map();

      labels.forEach((label, labelIndex) => {
        const group = byLabel.get(label).sort((a, b) => {
          const byName = a.name.localeCompare(b.name);
          if (byName !== 0) return byName;
          return a.id.localeCompare(b.id);
        });
        const radius = 90 + labelIndex * 72;
        const step = (Math.PI * 2) / Math.max(group.length, 1);
        group.forEach((node, index) => {
          const angle = index * step + labelIndex * 0.23;
          positions.set(node.id, {
            x: centerX + Math.cos(angle) * radius,
            y: centerY + Math.sin(angle) * radius
          });
        });
      });

      return positions;
    }

    function renderInspector(node) {
      const inspector = el('inspector');
      if (!node) {
        inspector.innerHTML =
          '<div class="hint">Click a node to focus it, inspect its memberships, and understand how it fits into the graph.</div>';
        return;
      }

      const processLabels = node.processIds.map((id) => {
        const match = PAYLOAD.slices.processes.find((entry) => entry.id === id);
        return match ? match.label : id;
      });
      const communityLabels = node.communityIds.map((id) => {
        const match = PAYLOAD.slices.communities.find((entry) => entry.id === id);
        return match ? match.label : id;
      });

      inspector.innerHTML =
        '<div><strong>' + escapeHtml(node.name) + '</strong></div>' +
        '<div>Type: <code>' + escapeHtml(node.label) + '</code></div>' +
        '<div>ID: <code>' + escapeHtml(node.id) + '</code></div>' +
        '<div>Why it matters: this node is part of the currently visible architecture slice.</div>' +
        '<div>Path: <code>' + escapeHtml(node.filePath || 'n/a') + '</code></div>' +
        '<div>Folders / modules: ' + escapeHtml(node.areaIds.join(', ') || 'n/a') + '</div>' +
        '<div>Execution flows: ' + escapeHtml(processLabels.join(', ') || 'n/a') + '</div>' +
        '<div>Functional areas: ' + escapeHtml(communityLabels.join(', ') || 'n/a') + '</div>';
    }

    function applyPreset(preset) {
      const processSelect = el('process-filter');
      const communitySelect = el('community-filter');
      const areaSelect = el('area-filter');
      const labelSelect = el('label-filter');
      const relationshipSelect = el('relationship-filter');

      setMultiSelectValues(processSelect, []);
      setMultiSelectValues(communitySelect, []);
      setMultiSelectValues(areaSelect, []);
      setMultiSelectValues(labelSelect, []);
      setMultiSelectValues(relationshipSelect, []);
      el('anchor-filter').value = '';
      selectedNodeId = '';
      el('depth-filter').value = '2';

      if (preset === 'flows') {
        setMultiSelectValues(labelSelect, ['Process', 'Function', 'Method', 'Route', 'Tool']);
        setMultiSelectValues(relationshipSelect, ['STEP_IN_PROCESS', 'CALLS', 'ENTRY_POINT_OF']);
      } else if (preset === 'areas') {
        setMultiSelectValues(labelSelect, ['Community', 'Function', 'Method', 'Class', 'File']);
        setMultiSelectValues(relationshipSelect, ['MEMBER_OF', 'CALLS', 'CONTAINS']);
      } else if (preset === 'structure') {
        setMultiSelectValues(labelSelect, ['Folder', 'Module', 'File']);
        setMultiSelectValues(relationshipSelect, ['CONTAINS', 'IMPORTS']);
      }

      renderGraph();
    }

    function renderGraph() {
      const selectedProcesses = selectedValues(el('process-filter'));
      const selectedCommunities = selectedValues(el('community-filter'));
      const selectedAreas = selectedValues(el('area-filter'));
      const selectedLabels = selectedValues(el('label-filter'));
      const selectedRelationshipTypes = selectedValues(el('relationship-filter'));
      const anchorId = el('anchor-filter').value || selectedNodeId;
      const depth = Number(el('depth-filter').value || '2');

      const filteredNodes = PAYLOAD.nodes.filter((node) =>
        matchesFilter(node.processIds, selectedProcesses) &&
        matchesFilter(node.communityIds, selectedCommunities) &&
        matchesFilter(node.areaIds, selectedAreas) &&
        matchesScalar(node.label, selectedLabels)
      );

      const filteredNodeIds = new Set(filteredNodes.map((node) => node.id));
      const filteredRelationships = PAYLOAD.relationships.filter((relationship) =>
        matchesScalar(relationship.type, selectedRelationshipTypes) &&
        filteredNodeIds.has(relationship.sourceId) &&
        filteredNodeIds.has(relationship.targetId)
      );
      const depthNodeIds = applyDepthFilter(filteredNodeIds, anchorId, depth, filteredRelationships);
      const visibleNodes = filteredNodes.filter((node) => depthNodeIds.has(node.id));
      const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
      const visibleRelationships = filteredRelationships.filter((relationship) =>
        visibleNodeIds.has(relationship.sourceId) &&
        visibleNodeIds.has(relationship.targetId)
      );

      el('visible-nodes').textContent = String(visibleNodes.length);
      el('visible-edges').textContent = String(visibleRelationships.length);

      const activeSlices = [];
      if (selectedProcesses.length) activeSlices.push('flows');
      if (selectedCommunities.length) activeSlices.push('areas');
      if (selectedAreas.length) activeSlices.push('modules');
      if (selectedLabels.length) activeSlices.push('node types');
      if (selectedRelationshipTypes.length) activeSlices.push('edge types');
      if (anchorId) activeSlices.push('focus node');
      el('slice-state').textContent = activeSlices.length ? activeSlices.join(' + ') : 'All';
      el('graph-summary').textContent =
        'Showing ' +
        visibleNodes.length +
        ' nodes and ' +
        visibleRelationships.length +
        ' edges from ' +
        PAYLOAD.counts.nodes +
        ' nodes and ' +
        PAYLOAD.counts.relationships +
        ' edges in the exported graph.';
      el('depth-value').textContent = String(depth);

      const svg = el('graph');
      svg.innerHTML = '';

      if (visibleNodes.length === 0) {
        const foreign = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
        foreign.setAttribute('x', '0');
        foreign.setAttribute('y', '0');
        foreign.setAttribute('width', '1280');
        foreign.setAttribute('height', '820');
        foreign.innerHTML =
          '<div xmlns="http://www.w3.org/1999/xhtml" class="empty">No nodes match the current filters. Clear filters or lower the neighborhood depth to widen the view.</div>';
        svg.appendChild(foreign);
        renderInspector(anchorId ? byId.get(anchorId) : null);
        return;
      }

      const positions = deriveLayout(visibleNodes);

      for (const relationship of visibleRelationships) {
        const source = positions.get(relationship.sourceId);
        const target = positions.get(relationship.targetId);
        if (!source || !target) continue;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', String(source.x));
        line.setAttribute('y1', String(source.y));
        line.setAttribute('x2', String(target.x));
        line.setAttribute('y2', String(target.y));
        line.setAttribute('stroke', 'var(--edge)');
        line.setAttribute('stroke-width', relationship.type === 'CALLS' ? '1.2' : '1');
        svg.appendChild(line);
      }

      for (const node of visibleNodes) {
        const position = positions.get(node.id);
        if (!position) continue;
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.style.cursor = 'pointer';

        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', String(position.x));
        circle.setAttribute('cy', String(position.y));
        circle.setAttribute('r', node.id === anchorId ? '12' : '9');
        circle.setAttribute('fill', colorForLabel(node.label));
        circle.setAttribute('stroke', node.id === anchorId ? '#0f172a' : '#ffffff');
        circle.setAttribute('stroke-width', node.id === anchorId ? '3' : '2');

        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', String(position.x + 14));
        label.setAttribute('y', String(position.y + 4));
        label.setAttribute('font-size', '11');
        label.setAttribute('fill', '#334155');
        label.textContent = shortName(node.name);

        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent =
          node.name +
          ' (' +
          node.label +
          ')' +
          (node.filePath ? '\\n' + node.filePath : '') +
          (node.processIds.length ? '\\nExecution flows: ' + node.processIds.join(', ') : '') +
          (node.communityIds.length ? '\\nFunctional areas: ' + node.communityIds.join(', ') : '');

        group.appendChild(circle);
        group.appendChild(label);
        group.appendChild(title);
        group.addEventListener('click', function() {
          selectedNodeId = node.id;
          el('anchor-filter').value = node.id;
          renderInspector(node);
          renderGraph();
        });
        svg.appendChild(group);
      }

      renderInspector(anchorId ? byId.get(anchorId) : null);
    }

    function init() {
      fillSelect(el('process-filter'), PAYLOAD.slices.processes, false);
      fillSelect(el('community-filter'), PAYLOAD.slices.communities, false);
      fillSelect(el('area-filter'), PAYLOAD.slices.areas, false);
      fillSelect(el('label-filter'), PAYLOAD.slices.nodeLabels, false);
      fillSelect(el('relationship-filter'), PAYLOAD.slices.relationshipTypes, false);
      fillSelect(el('anchor-filter'), PAYLOAD.slices.anchors, true);

      renderLegend();

      for (const id of ['process-filter', 'community-filter', 'area-filter', 'label-filter', 'relationship-filter', 'anchor-filter', 'depth-filter']) {
        el(id).addEventListener('change', renderGraph);
        el(id).addEventListener('input', renderGraph);
      }

      el('process-search').addEventListener('input', function(event) {
        filterSelectByQuery(el('process-filter'), event.target.value);
      });
      el('community-search').addEventListener('input', function(event) {
        filterSelectByQuery(el('community-filter'), event.target.value);
      });
      el('area-search').addEventListener('input', function(event) {
        filterSelectByQuery(el('area-filter'), event.target.value);
      });
      el('anchor-search').addEventListener('input', function(event) {
        filterSelectByQuery(el('anchor-filter'), event.target.value);
      });

      el('reset-filters').addEventListener('click', function() {
        applyPreset('overview');
      });

      for (const button of document.querySelectorAll('[data-preset]')) {
        button.addEventListener('click', function() {
          applyPreset(button.dataset.preset);
        });
      }

      renderGraph();
    }

    init();
  </script>
</body>
</html>`;
}

export function createGraphOverviewHtml(
  graph: { nodes: GraphNode[]; relationships: GraphRelationship[] },
  provenance: GraphHtmlExportProvenance,
): string {
  return renderGraphOverviewHtml(buildGraphHtmlPayload(graph, provenance));
}
