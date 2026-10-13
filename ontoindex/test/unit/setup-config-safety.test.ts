import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

describe('Claude pre-tool hook', () => {
  it('uses only an installed CLI with a timeout and no npx install', async () => {
    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../hooks/claude/pre-tool-use.sh',
    );
    const source = await readFile(file, 'utf-8');
    expect(source).not.toContain('npx -y');
    expect(source).toContain('command -v ontoindex');
    expect(source).toContain('timeout 2');
  });
});
