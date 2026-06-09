/**
 * Defines the contract versions for OntoIndex components.
 * This ensures that the CLI, Web UI, and MCP server agree on schemas and APIs.
 */

interface ContractVersion {
  graph_schema: number;
  meta_json: number;
  mcp_tools: number;
  web_api: number;
}

export const CURRENT_CONTRACT: ContractVersion = {
  graph_schema: 1,
  meta_json: 1,
  mcp_tools: 1,
  web_api: 1,
};
