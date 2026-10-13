/**
 * Clean Command
 *
 * Removes the .ontoindex index from the current repository.
 * Also unregisters it from the global registry.
 */

import fs from 'fs/promises';
import {
  findRepo,
  unregisterRepo,
  listRegisteredRepos,
  cleanGenerations,
} from '../storage/repo-manager.js';

export const cleanCommand = async (options?: {
  force?: boolean;
  all?: boolean;
  generations?: boolean;
  keep?: string;
}) => {
  if (options?.generations) {
    try {
      const keep = options.keep ?? '2';
      if (!/^\d+$/.test(keep) || Number(keep) > 10)
        throw new Error('--keep must be an integer from 0 to 10');
      const repo = options.all ? null : await findRepo(process.cwd());
      const targets = options.all
        ? await listRegisteredRepos()
        : repo
          ? [{ name: repo.repoPath, storagePath: repo.storagePath }]
          : [];
      if (!targets.length) {
        console.log('No indexed repositories found.');
        return;
      }
      const size = (bytes: number) =>
        bytes >= 1024 ** 3
          ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
          : bytes >= 1024 ** 2
            ? `${(bytes / 1024 ** 2).toFixed(2)} MB`
            : bytes >= 1024
              ? `${(bytes / 1024).toFixed(2)} KB`
              : `${bytes} B`;
      for (const target of targets) {
        const result = await cleanGenerations(target.storagePath, {
          dryRun: !options.force,
          keepNewest: Number(keep),
        });
        console.log(`${target.name}: ${size(result.bytesReclaimable)} reclaimable`);
        for (const generation of result.kept)
          console.log(`  Keep ${generation.name}: ${generation.reason}`);
        for (const generation of result.candidates ?? [])
          console.log(`  Would delete ${generation.name}: ${size(generation.bytes)}`);
        for (const generation of result.deleted)
          console.log(`  Deleted ${generation.name}: ${size(generation.bytes)}`);
        for (const generation of result.skipped)
          console.log(`  Skipped ${generation.name}: ${generation.reason}`);
      }
      if (!options.force) console.log('Run with --force to delete');
    } catch (err) {
      console.error('Failed to clean generations:', err);
      process.exitCode = 1;
    }
    return;
  }
  // --all flag: clean all indexed repos
  if (options?.all) {
    if (!options?.force) {
      const entries = await listRegisteredRepos();
      if (entries.length === 0) {
        console.log('No indexed repositories found.');
        return;
      }
      console.log(`This will delete OntoIndex indexes for ${entries.length} repo(s):`);
      for (const entry of entries) {
        console.log(`  - ${entry.name} (${entry.path})`);
      }
      console.log('\nRun with --force to confirm deletion.');
      return;
    }

    const entries = await listRegisteredRepos();
    for (const entry of entries) {
      try {
        await fs.rm(entry.storagePath, { recursive: true, force: true });
        await unregisterRepo(entry.path);
        console.log(`Deleted: ${entry.name} (${entry.storagePath})`);
      } catch (err) {
        console.error(`Failed to delete ${entry.name}:`, err);
      }
    }
    return;
  }

  // Default: clean current repo
  const cwd = process.cwd();
  const repo = await findRepo(cwd);

  if (!repo) {
    console.log('No indexed repository found in this directory.');
    return;
  }

  const repoName = repo.repoPath.split(/[/\\]/).pop() || repo.repoPath;

  if (!options?.force) {
    console.log(`This will delete the OntoIndex index for: ${repoName}`);
    console.log(`   Path: ${repo.storagePath}`);
    console.log('\nRun with --force to confirm deletion.');
    return;
  }

  try {
    await fs.rm(repo.storagePath, { recursive: true, force: true });
    await unregisterRepo(repo.repoPath);
    console.log(`Deleted: ${repo.storagePath}`);
  } catch (err) {
    console.error('Failed to delete:', err);
  }
};
