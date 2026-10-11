import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ContractRegistry } from './types.js';
import { resolveContainedMetadataPath } from '../../mcp/local/path-util.js';

function groupStorageRoot(groupDir: string): string {
  const absolute = path.resolve(groupDir);
  return path.basename(path.dirname(absolute)) === 'groups'
    ? path.dirname(path.dirname(absolute))
    : absolute;
}

const CONTRACTS_FILE = 'contracts.json';

export function getDefaultOntoIndexDir(): string {
  return process.env.ONTOINDEX_HOME || path.join(os.homedir(), '.ontoindex');
}

export function getGroupsBaseDir(ontoindexDir?: string): string {
  return path.join(ontoindexDir || getDefaultOntoIndexDir(), 'groups');
}

const GROUP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function validateGroupName(name: string): void {
  if (!GROUP_NAME_RE.test(name)) {
    throw new Error(
      `Invalid group name "${name}". Names must start with a letter or digit and contain only [a-zA-Z0-9_-].`,
    );
  }
}

export function getGroupDir(ontoindexDir: string, groupName: string): string {
  validateGroupName(groupName);
  return path.join(ontoindexDir, 'groups', groupName);
}

export async function writeContractRegistry(
  groupDir: string,
  registry: ContractRegistry,
): Promise<void> {
  const root = groupStorageRoot(groupDir);
  const targetPath = await resolveContainedMetadataPath(root, path.join(groupDir, CONTRACTS_FILE));
  const tmpPath = await resolveContainedMetadataPath(
    root,
    `${targetPath}.tmp.${process.pid}.${Date.now()}`,
  );
  let created = false;
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(registry, null, 2), {
      encoding: 'utf-8',
      flag: 'wx',
    });
    created = true;
    await resolveContainedMetadataPath(root, targetPath);
    await fsp.rename(tmpPath, targetPath);
  } catch (error) {
    if (created)
      await resolveContainedMetadataPath(root, tmpPath)
        .then((safePath) => fsp.rm(safePath, { force: true }))
        .catch(() => undefined);
    throw error;
  }
}

export async function readContractRegistry(groupDir: string): Promise<ContractRegistry | null> {
  const filePath = await resolveContainedMetadataPath(
    groupStorageRoot(groupDir),
    path.join(groupDir, CONTRACTS_FILE),
  );
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(content) as ContractRegistry;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listGroups(ontoindexDir?: string): Promise<string[]> {
  const root = ontoindexDir || getDefaultOntoIndexDir();
  const groupsDir = await resolveContainedMetadataPath(root, getGroupsBaseDir(root));
  try {
    const entries = await fsp.readdir(groupsDir, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      await resolveContainedMetadataPath(root, path.join(groupsDir, entry.name));
      if (entry.isDirectory()) {
        const yamlPath = await resolveContainedMetadataPath(
          root,
          path.join(groupsDir, entry.name, 'group.yaml'),
        );
        if (fs.existsSync(yamlPath)) {
          names.push(entry.name);
        }
      }
    }
    return names;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function createGroupDir(
  ontoindexDir: string,
  groupName: string,
  force: boolean = false,
): Promise<string> {
  const groupDir = await resolveContainedMetadataPath(
    ontoindexDir,
    getGroupDir(ontoindexDir, groupName),
  );
  const yamlPath = await resolveContainedMetadataPath(
    ontoindexDir,
    path.join(groupDir, 'group.yaml'),
  );
  if (fs.existsSync(yamlPath) && !force) {
    throw new Error(`Group "${groupName}" already exists. Use --force to overwrite.`);
  }
  await fsp.mkdir(groupDir, { recursive: true });

  const template = `version: 1
name: ${groupName}
description: ""

repos: {}

links: []

packages: {}

detect:
  http: true
  grpc: true
  topics: true
  shared_libs: false
  embedding_fallback: true

matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`;
  await resolveContainedMetadataPath(ontoindexDir, yamlPath);
  await fsp.writeFile(yamlPath, template, 'utf-8');
  return groupDir;
}
