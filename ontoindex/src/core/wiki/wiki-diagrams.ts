/**
 * Wiki Diagrams — pure graph-to-Mermaid conversion utilities.
 *
 * No filesystem I/O, no async, no HTTP calls. All functions are synchronous
 * and have no imports from outside the wiki/ directory.
 */

const MERMAID_MAX_NODES = 20;
const MERMAID_MAX_PROCESS_STEPS = 12;

function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40) || 'node';
}

function quoteLabel(name: string): string {
  if (/[(),'"\s`]/.test(name)) return `"${name.replace(/"/g, "'").replace(/`/g, "'")}"`;
  return name;
}

export interface CallEdge {
  fromName: string;
  toName: string;
}

export interface InterModuleEdge {
  from: string;
  to: string;
  count: number;
}

export interface ProcessStep {
  name: string;
  step: number;
}

/**
 * Build a Mermaid flowchart (LR) from a list of call edges.
 * Returns an empty string when there are no edges.
 */
export function buildMermaidCallFlow(edges: CallEdge[]): string {
  const capped = edges.slice(0, MERMAID_MAX_NODES);
  if (capped.length === 0) return '';
  const lines = ['flowchart LR'];
  const seen = new Set<string>();
  for (const e of capped) {
    const fromId = sanitizeId(e.fromName);
    const toId = sanitizeId(e.toName);
    if (!seen.has(fromId)) {
      lines.push(`  ${fromId}[${quoteLabel(e.fromName)}]`);
      seen.add(fromId);
    }
    if (!seen.has(toId)) {
      lines.push(`  ${toId}[${quoteLabel(e.toName)}]`);
      seen.add(toId);
    }
    lines.push(`  ${fromId} --> ${toId}`);
  }
  return lines.join('\n');
}

/**
 * Build a Mermaid graph (TD) from inter-module dependency edges.
 * Edge labels show the cross-dependency count.
 * Returns an empty string when there are no edges.
 */
export function buildMermaidInterModuleGraph(edges: InterModuleEdge[]): string {
  const capped = edges.slice(0, MERMAID_MAX_NODES);
  if (capped.length === 0) return '';
  const lines = ['graph TD'];
  const seen = new Set<string>();
  for (const e of capped) {
    const fromId = sanitizeId(e.from);
    const toId = sanitizeId(e.to);
    if (!seen.has(fromId)) {
      lines.push(`  ${fromId}[${quoteLabel(e.from)}]`);
      seen.add(fromId);
    }
    if (!seen.has(toId)) {
      lines.push(`  ${toId}[${quoteLabel(e.to)}]`);
      seen.add(toId);
    }
    lines.push(`  ${fromId} -->|${e.count}| ${toId}`);
  }
  return lines.join('\n');
}

/**
 * Build a Mermaid sequenceDiagram from an ordered list of process steps.
 * Requires at least 2 steps to produce output.
 * Returns an empty string when fewer than 2 steps are provided.
 */
export function buildMermaidProcessTrace(steps: ProcessStep[]): string {
  const capped = steps.slice(0, MERMAID_MAX_PROCESS_STEPS);
  if (capped.length < 2) return '';
  const lines = ['sequenceDiagram'];
  const participants = [...new Set(capped.map((s) => sanitizeId(s.name)))];
  for (const p of participants) lines.push(`  participant ${p}`);
  for (let i = 0; i + 1 < capped.length; i++) {
    const a = sanitizeId(capped[i].name);
    const b = sanitizeId(capped[i + 1].name);
    lines.push(`  ${a}->>${b}: step ${capped[i + 1].step}`);
  }
  return lines.join('\n');
}
