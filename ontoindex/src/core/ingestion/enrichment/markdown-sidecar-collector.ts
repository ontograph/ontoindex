import { createHash } from 'node:crypto';

import { readFileContents, walkRepositoryPaths } from '../filesystem-walker.js';
import { hashText } from './markdown-sidecar-producer.js';
import type { MarkdownSidecarDocumentInput } from './markdown-sidecar-runner.js';

export interface CollectedMarkdownSidecarDocuments {
  documents: MarkdownSidecarDocumentInput[];
  scopeHash: string;
}

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);

export async function collectMarkdownSidecarDocuments(
  repoPath: string,
  sourceCommitHash: string,
): Promise<CollectedMarkdownSidecarDocuments> {
  const scanned = await walkRepositoryPaths(repoPath);
  const markdownPaths = scanned
    .map((file) => file.path)
    .filter((filePath) => MARKDOWN_EXTENSIONS.has(extension(filePath)))
    .sort();
  const contents = await readFileContents(repoPath, markdownPaths);
  const documents = markdownPaths
    .map((docPath) => {
      const source = contents.get(docPath);
      if (source === undefined) return undefined;
      return { docPath, source, sourceCommitHash };
    })
    .filter((document): document is MarkdownSidecarDocumentInput => document !== undefined);

  return {
    documents,
    scopeHash: createMarkdownSidecarScopeHash(documents),
  };
}

export function createMarkdownSidecarScopeHash(
  documents: readonly MarkdownSidecarDocumentInput[],
): string {
  const hash = createHash('sha256');
  for (const document of [...documents].sort((left, right) =>
    left.docPath.localeCompare(right.docPath),
  )) {
    hash.update(document.docPath);
    hash.update('\0');
    hash.update(hashText(document.source));
    hash.update('\0');
    hash.update(document.sourceCommitHash);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function extension(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot === -1 ? '' : filePath.slice(dot).toLowerCase();
}
