import React, { useEffect, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import { runQuery } from '../services/backend-client';

interface GraphPanelProps {
  repo: string;
}

export const GraphPanel: React.FC<GraphPanelProps> = ({ repo }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': '#6366f1',
            label: 'data(name)',
            color: '#ffffff',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '8px',
            width: '25px',
            height: '25px',
          },
        },
        {
          selector: 'edge',
          style: {
            width: 1.5,
            'line-color': '#3b82f6',
            opacity: 0.6,
            'target-arrow-color': '#3b82f6',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
          },
        },
      ],
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      if (!cyRef.current) return;
      setLoading(true);
      setError(null);

      try {
        // Query for a sample of nodes and their relationships
        const rows = await runQuery('MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 20', repo);

        const elements: cytoscape.ElementDefinition[] = [];
        const addedNodes = new Set<string>();

        rows.forEach((row: any) => {
          const n = row.n;
          const r = row.r;
          const m = row.m;

          if (n && !addedNodes.has(n.id)) {
            elements.push({ data: { id: n.id, name: n.name || n.id } });
            addedNodes.add(n.id);
          }
          if (m && !addedNodes.has(m.id)) {
            elements.push({ data: { id: m.id, name: m.name || m.id } });
            addedNodes.add(m.id);
          }
          if (n && m && r) {
            elements.push({ data: { id: r.id || `${n.id}-${m.id}`, source: n.id, target: m.id } });
          }
        });

        // Fallback if no relationships: just get nodes
        if (elements.length === 0) {
          const nodeRows = await runQuery('MATCH (n) RETURN n LIMIT 20', repo);
          nodeRows.forEach((row: any) => {
            const n = row.n;
            if (n && !addedNodes.has(n.id)) {
              elements.push({ data: { id: n.id, name: n.name || n.id } });
              addedNodes.add(n.id);
            }
          });
        }

        cyRef.current.add(elements);
        cyRef.current.layout({ name: 'cose', animate: true }).run();
      } catch (err: any) {
        setError(err.message || 'Failed to fetch graph data');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [repo]);

  return (
    <div className="bg-surface-dark flex h-full w-full flex-col">
      <div className="flex items-center justify-between border-b border-border-subtle bg-surface px-4 py-2">
        <div className="text-xs font-medium text-text-muted">Knowledge Graph: {repo}</div>
        {loading && <div className="animate-pulse text-[10px] text-accent">Loading...</div>}
        {error && <div className="text-[10px] text-red-400">{error}</div>}
      </div>
      <div ref={containerRef} className="flex-1" />
    </div>
  );
};
