import { describe, it, expect } from 'vitest';
import {
  buildMermaidCallFlow,
  buildMermaidInterModuleGraph,
  buildMermaidProcessTrace,
  type CallEdge,
  type InterModuleEdge,
  type ProcessStep,
} from '../../src/core/wiki/wiki-diagrams.js';

describe('buildMermaidCallFlow', () => {
  it('returns empty string for empty edges array', () => {
    expect(buildMermaidCallFlow([])).toBe('');
  });

  it('returns a flowchart LR diagram for a single edge', () => {
    const result = buildMermaidCallFlow([{ fromName: 'A', toName: 'B' }]);
    expect(result).toContain('flowchart LR');
    expect(result).toContain('A');
    expect(result).toContain('B');
    expect(result).toContain('-->');
  });

  it('double-quotes node labels containing parentheses', () => {
    const result = buildMermaidCallFlow([{ fromName: 'doSomething()', toName: 'B' }]);
    // Label with parens must be quoted
    expect(result).toContain('"doSomething()"');
  });

  it('double-quotes node labels containing backticks', () => {
    const result = buildMermaidCallFlow([{ fromName: 'fn`name`', toName: 'target' }]);
    // Backticks trigger quoting; backticks inside are converted to single quotes
    expect(result).toMatch(/"fn'name'"/);
  });

  it('caps output at MERMAID_MAX_NODES (20) edges even if more are provided', () => {
    const edges: CallEdge[] = Array.from({ length: 25 }, (_, i) => ({
      fromName: `F${i}`,
      toName: `T${i}`,
    }));
    const result = buildMermaidCallFlow(edges);
    // 21st edge (F20→T20) must NOT appear in output
    expect(result).not.toContain('F20');
    expect(result).not.toContain('T20');
    // 20th edge (F19→T19) must appear
    expect(result).toContain('F19');
  });

  it('does not duplicate node declarations for repeated names', () => {
    const edges: CallEdge[] = [
      { fromName: 'A', toName: 'B' },
      { fromName: 'A', toName: 'C' },
    ];
    const result = buildMermaidCallFlow(edges);
    // "A[A]" should appear exactly once
    const matches = result.match(/\bA\[A\]/g);
    expect(matches).toHaveLength(1);
  });
});

describe('buildMermaidInterModuleGraph', () => {
  it('returns empty string for empty edges array', () => {
    expect(buildMermaidInterModuleGraph([])).toBe('');
  });

  it('builds a graph TD diagram with node labels and edge count', () => {
    const result = buildMermaidInterModuleGraph([{ from: 'X', to: 'Y', count: 5 }]);
    expect(result).toContain('graph TD');
    expect(result).toContain('X');
    expect(result).toContain('Y');
    expect(result).toContain('5');
  });

  it('encodes the count in the edge label', () => {
    const result = buildMermaidInterModuleGraph([{ from: 'Auth', to: 'DB', count: 12 }]);
    expect(result).toContain('-->|12|');
  });

  it('caps at MERMAID_MAX_NODES edges', () => {
    const edges: InterModuleEdge[] = Array.from({ length: 25 }, (_, i) => ({
      from: `M${i}`,
      to: `N${i}`,
      count: i,
    }));
    const result = buildMermaidInterModuleGraph(edges);
    expect(result).not.toContain('M20');
    expect(result).toContain('M19');
  });
});

describe('buildMermaidProcessTrace', () => {
  it('returns empty string for fewer than 2 steps', () => {
    expect(buildMermaidProcessTrace([])).toBe('');
    expect(buildMermaidProcessTrace([{ name: 'OnlyStep', step: 1 }])).toBe('');
  });

  it('returns a sequenceDiagram with participants and arrows for 2+ steps', () => {
    const steps: ProcessStep[] = [
      { name: 'StepA', step: 1 },
      { name: 'StepB', step: 2 },
    ];
    const result = buildMermaidProcessTrace(steps);
    expect(result).toContain('sequenceDiagram');
    expect(result).toContain('participant StepA');
    expect(result).toContain('participant StepB');
    expect(result).toContain('->>');
  });

  it('generates arrow lines stepping through adjacent pairs', () => {
    const steps: ProcessStep[] = [
      { name: 'Alpha', step: 1 },
      { name: 'Beta', step: 2 },
      { name: 'Gamma', step: 3 },
    ];
    const result = buildMermaidProcessTrace(steps);
    expect(result).toContain('Alpha->>Beta: step 2');
    expect(result).toContain('Beta->>Gamma: step 3');
  });

  it('sanitizes step names for participant IDs (special chars become underscores)', () => {
    const steps: ProcessStep[] = [
      { name: 'my.func()', step: 1 },
      { name: 'other-fn', step: 2 },
    ];
    const result = buildMermaidProcessTrace(steps);
    // sanitizeId replaces non-alphanumeric/underscore chars
    expect(result).toContain('participant my_func__');
    expect(result).toContain('participant other_fn');
  });
});
