import { describe, it, expect } from 'vitest';
import { getRuntimeDiagnosticsSnapshot } from '../../src/core/runtime/runtime-diagnostics.js';
import { EvidenceReadLedger } from '../../src/core/runtime/evidence-read-ledger.js';
import { type MCPDiagnosticsSnapshot } from '../../src/server/mcp-http.js';
import { buildApiMcpDiagnosticsResponse } from '../../src/server/api.js';

describe('Runtime Diagnostics', () => {
  const mockMcpSnapshot: MCPDiagnosticsSnapshot = {
    activeSessions: [
      {
        sessionId: 'secret-session-id-123',
        createdAt: 1000,
        lastActivity: 2000,
        requestCount: 10,
        errorCount: 0,
      },
    ],
    activeSessionCount: 1,
    totalSessionsCreated: 1,
    totalEvictions: 0,
    totalCapEvictions: 0,
    capturedAt: 3000,
  };

  it('composes MCP and ledger diagnostics into a snapshot', () => {
    const ledger = new EvidenceReadLedger();
    ledger.record({
      readClass: 'graph_evidence',
      surface: 'test',
      target: 'target1',
      targetType: 'symbol',
    });

    const snapshot = getRuntimeDiagnosticsSnapshot(mockMcpSnapshot, ledger);

    expect(snapshot.mcp).toEqual(mockMcpSnapshot);
    expect(snapshot.evidenceReadLedger.total).toBe(1);
    expect(snapshot.evidenceReadLedger.byClass.graph_evidence).toBe(1);
    expect(snapshot.capturedAt).toBeGreaterThan(0);
  });

  it('redacts session IDs in API response', () => {
    const response = buildApiMcpDiagnosticsResponse(mockMcpSnapshot);

    expect(response.activeSessions[0].sessionIdHash).toBeDefined();
    expect(response.activeSessions[0].sessionIdHash).not.toBe('secret-session-id-123');
    expect(response.activeSessions[0].sessionIdHash.length).toBe(16);

    const json = JSON.stringify(response);
    expect(json).not.toContain('secret-session-id-123');
  });

  it('excludes sensitive fields from ledger summary in API response', () => {
    const ledger = new EvidenceReadLedger();
    ledger.record({
      readClass: 'graph_evidence',
      surface: 'test',
      target: 'secret-target-path',
      targetType: 'test',
      isSensitive: true,
    });

    const snapshot = getRuntimeDiagnosticsSnapshot(mockMcpSnapshot, ledger);
    const response = buildApiMcpDiagnosticsResponse(snapshot);

    expect(response.evidenceReadLedger).toBeDefined();
    // recentTargets should be excluded from API response
    expect((response.evidenceReadLedger as any).recentTargets).toBeUndefined();
    expect(response.evidenceReadLedger!.total).toBe(1);

    const json = JSON.stringify(response);
    expect(json).not.toContain('secret-target-path');
  });

  it('supports backwards compatibility with old MCP snapshots', () => {
    // buildApiMcpDiagnosticsResponse should accept plain MCPDiagnosticsSnapshot
    const response = buildApiMcpDiagnosticsResponse(mockMcpSnapshot);
    expect(response.evidenceReadLedger).toBeUndefined();
    expect(response.activeSessionCount).toBe(1);
  });
});
