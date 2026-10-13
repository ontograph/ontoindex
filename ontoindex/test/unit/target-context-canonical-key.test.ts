import { expect, it } from 'vitest';
import {
  registryRepoIds,
  resolveRegistryEntry,
  resolveTargetContext,
} from '../../src/mcp/shared/target-context.js';

const entry = (name: string, path: string) => ({
  name,
  path,
  storagePath: `${path}/.ontoindex`,
  indexedAt: 'index',
  lastCommit: 'abc',
});

it('returns canonical keys that round-trip for duplicate names and available repositories', async () => {
  const registry = [entry('demo', '/tmp/canonical-demo-a'), entry('demo', '/tmp/canonical-demo-b')];
  const ids = registryRepoIds(registry);
  for (const repo of registry) {
    const id = ids.get(repo)!;
    const context = await resolveTargetContext(
      { repo: id },
      { readRegistry: async () => registry, execGit: async () => '' },
    );
    expect(context.repoKey).toBe(id);
    expect(resolveRegistryEntry(registry, context.repoKey)).toEqual({ status: 'ok', entry: repo });
  }
  const context = await resolveTargetContext(
    { repo: 'demo' },
    { readRegistry: async () => registry },
  );
  expect(context.status).toBe('ambiguous');
  for (const summary of context.availableRepos!) {
    expect(resolveRegistryEntry(registry, summary.key)).toEqual({
      status: 'ok',
      entry: registry.find((repo) => repo.path === summary.path),
    });
  }
});

it('preserves unique repository keys', async () => {
  const registry = [entry('demo', '/tmp/canonical-demo')];
  const context = await resolveTargetContext(
    { repo: 'demo' },
    { readRegistry: async () => registry, execGit: async () => '' },
  );
  expect(context.repoKey).toBe('demo');
});
