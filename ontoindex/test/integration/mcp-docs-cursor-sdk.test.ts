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

describe('docs cursor binding over the real MCP SDK', () => {
  let root: string;
  let backend: LocalBackend;
  let client: Client;
  let server: ReturnType<typeof createMCPServer>;
  let sidecarPath: string;
  let sourceIndexId: string;
  let sourceCommitHash: string;
  const repoName = 'docs-cursor-sdk';
  const ids = ['REQ-1', 'REQ-2', 'REQ-3', 'REQ-4'];

  async function writeSidecar(changed = false) {
    const records = ids.map((requirementId, index) => ({
      kind: 'markdown-requirement',
      schemaVersion: 1,
      docPath: 'docs/requirements.md',
      headingPath: [requirementId],
      lineSpan: { start: index + 1, end: index + 1 },
      sourceChunkKey: `chunk:${requirementId}`,
      normalizedKey: requirementId,
      confidence: 1,
      evidence: {
        text: `${requirementId} requirement`,
        raw: `${requirementId} requirement`,
        lineSpan: { start: index + 1, end: index + 1 },
      },
      requirementId,
      title: `${requirementId} ${changed && index === 3 ? 'other' : 'title'}`,
      source: 'heading',
    }));
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({
        schemaVersion: 1,
        requests: [],
        lock: null,
        enrichments: [
          {
            sourceIndexId,
            sourceCommitHash,
            schemaVersion: 1,
            analyzerId: 'markdown-document-sidecar',
            analyzerVersion: '1.0.0',
            filePath: 'docs/requirements.md',
            fileHash: 'requirements-fixture',
            status: 'complete',
            confidence: 1,
            records,
          },
        ],
      }),
    );
  }

  async function call(action: 'context' | 'trace', cursor?: string) {
    return client.callTool({
      name: 'docs',
      arguments: { action, repo: repoName, maxItems: 1, ...(cursor ? { cursor } : {}) },
    });
  }

  function responseText(response: Awaited<ReturnType<typeof call>>) {
    return (response.content as Array<{ type: string; text?: string }>)
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
  }

  function page(response: Awaited<ReturnType<typeof call>>) {
    expect(response.isError).not.toBe(true);
    return JSON.parse(responseText(response).split('\n\n---\n')[0]) as {
      docsEvidence: Array<{ conceptId?: string; requirementId?: string; title?: string }>;
      cursor: { offset: number; next?: string };
    };
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-docs-cursor-sdk-'));
    const home = path.join(root, 'home');
    const repo = path.join(root, repoName);
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, 'registry.json'), '[]\n');
    vi.stubEnv('ONTOINDEX_HOME', home);
    vi.stubEnv('ONTOINDEX_AUTO_WORKSPACE', '1');
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.mkdir(path.join(repo, 'docs'));
    await fs.writeFile(path.join(repo, '.gitignore'), '.ontoindex/\n');
    await fs.writeFile(
      path.join(repo, 'src/base.ts'),
      'export function baseline() { return 1; }\n',
    );
    await fs.writeFile(
      path.join(repo, 'docs/requirements.md'),
      ids.map((id) => `# ${id} title`).join('\n'),
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
    git('commit', '-qm', 'docs cursor baseline');
    await runFullAnalysis(
      repo,
      {
        skipAgentsMd: true,
        noStats: true,
        registryName: repoName,
      },
      { onProgress() {} },
    );
    backend = new LocalBackend();
    await backend.init();
    const handle = await backend.resolveRepo(repoName);
    sourceIndexId = handle.indexedAt!;
    sourceCommitHash = handle.lastCommit!;
    sidecarPath = path.join(handle.storagePath, 'enrichment', 'sidecar-store.json');
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    server = createMCPServer(backend);
    client = new Client({ name: 'docs-cursor-sdk', version: '1' });
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
          resetOverlaySnapshotCache();
          vi.unstubAllEnvs();
          if (root) await fs.rm(root, { recursive: true, force: true });
        }
      }
    }
  });

  it.each(['context', 'trace'] as const)(
    '%s continues unchanged pages and rejects a same-length edit outside the first page',
    async (action) => {
      await writeSidecar();
      const originalBytes = (await fs.stat(sidecarPath)).size;
      const first = page(await call(action));
      expect(first.cursor.offset).toBe(0);
      expect(first.cursor.next).toEqual(expect.any(String));
      expect(first.docsEvidence).toHaveLength(1);
      const pages = [first];
      let cursor = first.cursor.next;
      while (cursor && pages.length <= ids.length) {
        const next = page(await call(action, cursor));
        expect(next.cursor.offset).toBe(pages.length);
        pages.push(next);
        cursor = next.cursor.next;
      }
      expect(cursor).toBeUndefined();
      expect(pages).toHaveLength(ids.length);
      const evidence = pages.flatMap((item) => item.docsEvidence);
      const collected = evidence.map((item) =>
        action === 'context' ? item.conceptId : item.requirementId,
      );
      expect(collected).not.toContain(undefined);
      expect(new Set(collected).size).toBe(ids.length);
      expect(evidence.every((item) => item.title !== 'REQ-4 other')).toBe(true);

      await writeSidecar(true);
      expect((await fs.stat(sidecarPath)).size).toBe(originalBytes);
      const stale = await call(action, first.cursor.next);
      expect(stale.isError).toBe(true);
      expect(responseText(stale)).toMatch(/restart pagination/i);
      const restarted = page(await call(action));
      expect(restarted.cursor.offset).toBe(0);
      expect(restarted.docsEvidence).toHaveLength(1);
    },
  );
});
