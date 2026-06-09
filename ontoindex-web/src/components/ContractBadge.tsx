import React, { useEffect, useState } from 'react';
import { fetchServerInfo, type ServerInfo } from '../services/backend-client';

export const ContractBadge: React.FC = () => {
  const [info, setInfo] = useState<ServerInfo | null>(null);

  useEffect(() => {
    fetchServerInfo()
      .then(setInfo)
      .catch((err) => console.error('Failed to fetch server info:', err));
  }, []);

  if (!info || !info.contract) return null;

  const { graph_schema, meta_json, mcp_tools, web_api } = info.contract;

  return (
    <div
      className="bg-surface-dark flex items-center gap-1 rounded-md border border-border-subtle px-2 py-0.5 font-mono text-[10px] text-text-muted"
      title={`Graph: v${graph_schema} • Meta: v${meta_json} • MCP: v${mcp_tools} • Web: v${web_api}`}
    >
      <span className="text-accent-blue">C</span>
      <span className="opacity-50">
        {graph_schema}.{meta_json}.{mcp_tools}.{web_api}
      </span>
    </div>
  );
};
