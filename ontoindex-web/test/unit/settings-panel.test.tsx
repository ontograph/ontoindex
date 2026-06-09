import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as backendClient from '../../src/services/backend-client';
import { SettingsPanel } from '../../src/components/SettingsPanel';

const renderSettingsPanel = () =>
  render(
    <SettingsPanel
      isOpen
      onClose={() => {}}
      backendUrl="http://localhost:4747"
      isBackendConnected
      onBackendUrlChange={() => {}}
    />,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SettingsPanel runtime MCP diagnostics', () => {
  it('renders an empty runtime diagnostics state', async () => {
    vi.spyOn(backendClient, 'fetchMcpDiagnostics').mockResolvedValue({
      activeSessions: [],
      activeSessionCount: 0,
      totalSessionsCreated: 0,
      totalIdleEvictions: 0,
      totalCapEvictions: 0,
      capturedAt: 1_700_000_000_000,
    });

    renderSettingsPanel();

    expect(screen.getByText('Runtime MCP diagnostics')).toBeInTheDocument();
    expect(screen.getByText(/does not indicate audit readiness/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('No active MCP runtime sessions.')).toBeInTheDocument();
    });

    expect(screen.getByText('Active sessions')).toBeInTheDocument();
    expect(screen.getByText('Total evictions')).toBeInTheDocument();
  });

  it('renders redacted active sessions and ignores forbidden fields', async () => {
    vi.spyOn(backendClient, 'fetchMcpDiagnostics').mockResolvedValue({
      activeSessions: [
        {
          sessionIdHash: '0123456789abcdef',
          ageMs: 65_000,
          lastActivityAt: 1_700_000_020_000,
          requestCount: 12,
          errorCount: 7,
          sessionId: 'session-secret-123',
          prompt: 'do not show',
          args: ['forbidden'],
          payload: { bad: true },
          recentTools: ['search'],
        } as backendClient.McpDiagnosticsResponse['activeSessions'][number],
      ],
      activeSessionCount: 1,
      totalSessionsCreated: 2,
      totalIdleEvictions: 1,
      totalCapEvictions: 2,
      capturedAt: 1_700_000_050_000,
      freshness: 'fresh',
      degraded: true,
    });

    renderSettingsPanel();

    await waitFor(() => {
      expect(screen.getByText('Session ••••abcdef')).toBeInTheDocument();
    });

    expect(screen.getByText('1m')).toBeInTheDocument();
    expect(screen.getByText('30s ago')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('Degraded runtime')).toBeInTheDocument();
    expect(screen.getByText('Freshness: fresh')).toBeInTheDocument();

    expect(screen.queryByText('0123456789abcdef')).not.toBeInTheDocument();
    expect(screen.queryByText('session-secret-123')).not.toBeInTheDocument();
    expect(screen.queryByText('do not show')).not.toBeInTheDocument();
    expect(screen.queryByText('forbidden')).not.toBeInTheDocument();
    expect(screen.queryByText('search')).not.toBeInTheDocument();
  });
});
