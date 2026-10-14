import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { collectMarkdownSidecarDocuments } from '../../src/core/ingestion/enrichment/markdown-sidecar-collector.js';

const rootFiles = [
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'LICENSE.md',
];
const sourceCommitHash = 'commit-1';

describe('collectMarkdownSidecarDocuments root files', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs.length = 0;
  });

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function createRepo(): Promise<string> {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-markdown-collector-'));
    tempDirs.push(repoPath);
    return repoPath;
  }

  it('collects the five allowlisted root Markdown files in docPath order', async () => {
    const repoPath = await createRepo();
    for (const fileName of [...rootFiles].reverse()) {
      await fs.writeFile(path.join(repoPath, fileName), `${fileName} content`);
    }

    const result = await collectMarkdownSidecarDocuments(repoPath, sourceCommitHash);

    expect(result.documents).toEqual(
      [...rootFiles]
        .sort()
        .map((docPath) => ({ docPath, source: `${docPath} content`, sourceCommitHash })),
    );
  });

  it('omits allowlisted files that are not present', async () => {
    const repoPath = await createRepo();
    await fs.writeFile(path.join(repoPath, 'SECURITY.md'), 'policy');

    const result = await collectMarkdownSidecarDocuments(repoPath, sourceCommitHash);

    expect(result.documents.map((document) => document.docPath)).toEqual(['SECURITY.md']);
  });

  it('changes scopeHash when SECURITY.md is added or its content changes', async () => {
    const repoPath = await createRepo();
    await fs.writeFile(path.join(repoPath, 'README.md'), 'readme');
    const withoutSecurity = await collectMarkdownSidecarDocuments(repoPath, sourceCommitHash);

    await fs.writeFile(path.join(repoPath, 'SECURITY.md'), 'policy v1');
    const withSecurity = await collectMarkdownSidecarDocuments(repoPath, sourceCommitHash);
    await fs.writeFile(path.join(repoPath, 'SECURITY.md'), 'policy v2');
    const changedSecurity = await collectMarkdownSidecarDocuments(repoPath, sourceCommitHash);

    expect(withSecurity.scopeHash).not.toBe(withoutSecurity.scopeHash);
    expect(changedSecurity.scopeHash).not.toBe(withSecurity.scopeHash);
  });

  it('returns the same scopeHash for the same files created in different orders', async () => {
    const firstRepo = await createRepo();
    const secondRepo = await createRepo();
    for (const fileName of rootFiles) {
      await fs.writeFile(path.join(firstRepo, fileName), `${fileName} content`);
    }
    for (const fileName of [...rootFiles].reverse()) {
      await fs.writeFile(path.join(secondRepo, fileName), `${fileName} content`);
    }

    const first = await collectMarkdownSidecarDocuments(firstRepo, sourceCommitHash);
    const second = await collectMarkdownSidecarDocuments(secondRepo, sourceCommitHash);

    expect(first.scopeHash).toBe(second.scopeHash);
    expect(first.documents).toEqual(second.documents);
  });
});
