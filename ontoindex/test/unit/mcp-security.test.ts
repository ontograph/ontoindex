import { describe, it, expect } from 'vitest';
import { canonicalize } from '../../src/mcp/local/path-util.js';
import path from 'path';

describe('canonicalize', () => {
  const repo = path.resolve('/repo');

  it('throws on path escaping repo via parent dir', () => {
    expect(() => canonicalize(repo, '../etc/passwd')).toThrow(/escapes repository/);
  });

  it('throws on absolute path outside repo', () => {
    expect(() => canonicalize(repo, '/etc/passwd')).toThrow(/escapes repository/);
  });

  it('returns absolute path for safe relative path', () => {
    const result = canonicalize(repo, 'src/foo.ts');
    expect(result).toBe(path.join(repo, 'src/foo.ts'));
  });

  it('throws on empty path', () => {
    expect(() => canonicalize(repo, '')).toThrow(/cannot be empty/);
  });

  it('throws on path escaping repo via nested parent dir', () => {
    expect(() => canonicalize(repo, 'src/../../etc/passwd')).toThrow(/escapes repository/);
  });

  it('allows repo root itself', () => {
    const result = canonicalize(repo, '.');
    expect(result).toBe(repo);
  });

  it('throws on null bytes', () => {
    expect(() => canonicalize(repo, 'src/foo.ts\0')).toThrow(/invalid characters/);
  });
});
