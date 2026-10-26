import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { resetOverlaySnapshotCache } from '../../src/mcp/local/backend-overlay.js';
import { createMCPServer } from '../../src/mcp/server.js';
import * as freshness from '../../src/mcp/super/ensure-fresh.js';
import type { DiagnoseReport } from '../../src/mcp/super/diagnose.js';
import type { CapabilityResponseEnvelope } from '../../src/mcp/shared/response-envelope.js';

describe('diagnostic privacy over the real MCP SDK', () => {
  let root: string;
  let backend: LocalBackend;
  let client: Client;
  let server: ReturnType<typeof createMCPServer>;
  const repoName = 'diagnostic-privacy-sdk';
  const secrets = {
    ONTOINDEX_HTTP_TOKEN: 'synthetic-sdk-http-token',
    ONTOINDEX_API_KEY: 'synthetic-sdk-api-key',
    ONTOINDEX_TEST_URL:
      'https://synthetic-sdk-user:synthetic-sdk-password@example.invalid/api?key=synthetic-sdk-query#synthetic-sdk-fragment',
    ONTOINDEX_TEST_ENDPOINT: 'https://example.invalid/synthetic-sdk-endpoint-path',
  };
  const markers = [
    ...Object.values(secrets),
    'synthetic-sdk-user',
    'synthetic-sdk-password',
    'synthetic-sdk-query',
    'synthetic-sdk-fragment',
    'synthetic-sdk-endpoint-path',
  ];

  async function diagnose(legacyResponse: boolean) {
    const response = await client.callTool({
      name: 'gn_diagnose',
      arguments: {
        repo: repoName,
        legacyResponse,
        checkLsp: false,
        checkToolContract: false,
        checkEmbeddings: true,
        checkIndexFreshness: true,
      },
    });
    expect(response.isError).not.toBe(true);
    // Inspect the entire SDK reply, including text outside the JSON report.
    const serialized = JSON.stringify(response);
    for (const marker of markers) expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain('semantic retrieval fell back to lexical/graph ranking');
    const text = (response.content as Array<{ type: string; text?: string }>)
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    const payload = JSON.parse(text.split('\n\n---\n')[0]) as
      | DiagnoseReport
      | CapabilityResponseEnvelope<Record<string, unknown>>;
    const report = legacyResponse
      ? (payload as DiagnoseReport)
      : ((payload as CapabilityResponseEnvelope<Record<string, unknown>>)
          .results as unknown as DiagnoseReport);
    if (legacyResponse) expect(report.version).toBe(1);
    else expect(payload).toMatchObject({ envelopeVersion: '1' });
    expect(report.envVars).toMatchObject({
      ...Object.fromEntries(Object.keys(secrets).map((key) => [key, '[REDACTED]'])),
      ONTOINDEX_CUSTOM_VAR: 'ordinary-sdk-scalar',
    });
    expect(report.setup.auth.httpApiToken).toBe('configured-env-token');
    return { payload, report, serialized };
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-diagnostic-privacy-sdk-'));
    const home = path.join(root, 'home');
    const repo = path.join(root, repoName);
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
    vi.stubEnv('ONTOINDEX_HOME', home);
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '0');
    vi.stubEnv('ONTOINDEX_VECTOR_BACKEND', 'lbug');
    vi.stubEnv('ONTOINDEX_MCP_AUTO_ANALYZE', '0');
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, '.gitignore'), '.ontoindex/\n');
    await fs.writeFile(
      path.join(repo, 'src/base.ts'),
      'export function baseline() { return 1; }\n',
    );
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-C',
          repo,
          ...args,
        ],
        { stdio: 'pipe' },
      );
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'diagnostic privacy baseline');
    await runFullAnalysis(
      repo,
      {
        skipAgentsMd: true,
        noStats: true,
        registryName: repoName,
        embeddings: false,
      },
      { onProgress() {} },
    );
    for (const [key, value] of Object.entries(secrets)) vi.stubEnv(key, value);
    vi.stubEnv('ONTOINDEX_CUSTOM_VAR', 'ordinary-sdk-scalar');
    freshness.resetFreshnessCache();
    backend = new LocalBackend();
    await backend.init();
    server = createMCPServer(backend);
    client = new Client({ name: repoName, version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }, 240_000);

  afterAll(async () => {
    try {
      await client?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        try {
          await backend?.disconnect();
        } finally {
          freshness.resetFreshnessCache();
          resetOverlaySnapshotCache();
          vi.restoreAllMocks();
          vi.unstubAllEnvs();
          if (root) await fs.rm(root, { recursive: true, force: true });
        }
      }
    }
  });

  for (const autoWorkspace of ['0', '1']) {
    for (const legacyResponse of [true, false]) {
      it(`redacts environment and reports absent embeddings with AUTO_WORKSPACE=${autoWorkspace}, legacy=${legacyResponse}`, async () => {
        vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', autoWorkspace);
        resetOverlaySnapshotCache();
        freshness.resetFreshnessCache();
        const { payload, report } = await diagnose(legacyResponse);
        expect(report.embeddings).toMatchObject({ count: 0, populated: false, status: 'missing' });
        expect(report.recommendations).toEqual(
          expect.arrayContaining([expect.objectContaining({ detail: 'Embeddings not populated' })]),
        );
        if (!legacyResponse) {
          expect(payload).toMatchObject({
            tool: 'gn_diagnose',
            status: 'degraded',
            capabilitiesMissing: expect.arrayContaining(['embeddings']),
            capabilitiesUsed: expect.arrayContaining(['embeddings-probe']),
          });
        }
      });

      it(`omits rejected probe content with AUTO_WORKSPACE=${autoWorkspace}, legacy=${legacyResponse}`, async () => {
        vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', autoWorkspace);
        resetOverlaySnapshotCache();
        const rejectedMarkers = ['synthetic-sdk-rejection-secret', 'synthetic-sdk-source-body'];
        const probe = vi
          .spyOn(freshness, 'gnEnsureFresh')
          .mockRejectedValue(
            new Error(`${rejectedMarkers[0]}\n${`${rejectedMarkers[1]}\n`.repeat(100)}`),
          );
        try {
          const { payload, report, serialized } = await diagnose(legacyResponse);
          expect(probe).toHaveBeenCalled();
          const warnings = legacyResponse ? report.warnings : payload.warnings;
          expect(warnings).toContain('gnEnsureFresh failed: freshness probe unavailable');
          expect(report.embeddings).toBeUndefined();
          for (const marker of rejectedMarkers) expect(serialized).not.toContain(marker);
        } finally {
          probe.mockRestore();
          freshness.resetFreshnessCache();
        }
      });
    }
  }
});
