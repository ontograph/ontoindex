import { type MCPDiagnosticsSnapshot } from '../../server/mcp-http.js';
import {
  defaultEvidenceReadLedger,
  type EvidenceReadSummary,
  type EvidenceReadLedger,
} from './evidence-read-ledger.js';

export interface RuntimeDiagnosticsSnapshot {
  mcp: MCPDiagnosticsSnapshot;
  evidenceReadLedger: EvidenceReadSummary;
  capturedAt: number;
}

export function getRuntimeDiagnosticsSnapshot(
  mcpDiagnostics: MCPDiagnosticsSnapshot,
  ledger: EvidenceReadLedger = defaultEvidenceReadLedger,
): RuntimeDiagnosticsSnapshot {
  return {
    mcp: mcpDiagnostics,
    evidenceReadLedger: ledger.getSummary(),
    capturedAt: Date.now(),
  };
}
