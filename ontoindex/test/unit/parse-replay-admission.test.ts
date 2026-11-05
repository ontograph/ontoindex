import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { processStructure } from '../../src/core/ingestion/structure-processor.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { admitScopeRetentionParseReplay } from '../../src/core/ingestion/pipeline-phases/parse-replay.js';
import { persistScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js';
import { loadScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js';
import { ANALYSIS_PACKS_ROOT } from '../../src/analysis-packs/catalog.js';
import { SupportedLanguages } from 'ontoindex-shared';

type Candidate = Parameters<typeof admitScopeRetentionParseReplay>[0];
type Current = {
  repoPath: string;
  allPaths: string[];
  scannedFiles: Parameters<typeof runChunkedParseAndResolve>[1];
  skippedLargeFiles: { path: string; size: number }[];
};
const sources = {
  'src/legacy.rs': 'pub const VALUE: i32 = 1;\npub fn legacy() {}\n',
  'src/util.ts': 'export function helper() {}\nexport function other() {}\n',
  'src/main.ts':
    "import { helper, other as renamed } from './util';\nfunction run() { helper(); renamed(); missing(); }\nexport function entry() { run(); }\n",
  'src/ns.ts':
    "import * as util from './util';\nexport function viaNamespace() { util.helper(); }\n",
};
const packageContent = '{"name":"replay-fixture","type":"module"}\n';
const configContent = '{"compilerOptions":{"baseUrl":"."}}\n';
const directories: string[] = [];
let candidate: Candidate;
let current: Current;

const request = () => ({ deadline: Date.now() + 60_000 });

describe.sequential('strict parse replay admission against live inputs', () => {
  beforeAll(async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'parse-replay-admission-repo-'));
    directories.push(repoPath);
    await fs.mkdir(path.join(repoPath, 'src'));
    await fs.mkdir(path.join(repoPath, ANALYSIS_PACKS_ROOT));
    await fs.writeFile(path.join(repoPath, ANALYSIS_PACKS_ROOT, 'fixture.txt'), 'original');
    for (const [filePath, content] of Object.entries(sources)) {
      await fs.writeFile(path.join(repoPath, filePath), content);
    }
    await fs.writeFile(path.join(repoPath, 'package.json'), packageContent);
    await fs.writeFile(path.join(repoPath, 'tsconfig.base.json'), configContent);
    const allPaths = [...Object.keys(sources), 'package.json', 'tsconfig.base.json'];
    const scannedFiles = allPaths.map((filePath) => ({
      path: filePath,
      size: Buffer.byteLength(
        filePath === 'package.json'
          ? packageContent
          : filePath === 'tsconfig.base.json'
            ? configContent
            : sources[filePath as keyof typeof sources],
      ),
    }));
    const graph = createKnowledgeGraph();
    processStructure(graph, allPaths);
    const result = await runChunkedParseAndResolve(
      graph,
      scannedFiles,
      allPaths,
      allPaths.length,
      repoPath,
      Date.now(),
      () => {},
      {
        skipWorkers: true,
        scopeRetention: {
          ...request(),
          artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
          consume: async () => {},
        },
      },
    );
    try {
      const handle = result.scopeRetention!;
      expect(handle.status).toBe('retained');
      expect(handle.inputEvidence.complete).toBe(true);
      expect(handle.inputEvidence.configuration).toMatchObject({ complete: true, issues: [] });
      expect(handle.inputEvidence.configuration!.records).toContainEqual(
        expect.objectContaining({ kind: 'file', path: 'tsconfig.json', status: 'absent' }),
      );
      expect(handle.inputEvidence.parserCodeIdentity).toMatch(/^[a-f0-9]{64}$/);
      expect(handle.inputEvidence.sources).toEqual(
        Object.keys(sources).map((filePath) => {
          const content = sources[filePath as keyof typeof sources];
          return {
            filePath,
            sha256: createHash('sha256').update(content).digest('hex'),
            byteLength: Buffer.byteLength(content),
          };
        }),
      );
      // Artifacts must not alter the repository configuration traversal observed by the producer.
      const generation = await fs.mkdtemp(
        path.join(os.tmpdir(), 'parse-replay-admission-candidate-'),
      );
      directories.push(generation);
      const identity = {
        sourceManifestDigest: 'a'.repeat(64),
        targetCommit: 'fixture-head',
        baseGenerationId: null,
      };
      await persistScopeRetentionCandidate(handle, generation, identity, {
        ...request(),
        artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
      });
      candidate = await loadScopeRetentionCandidate(
        generation,
        {
          identity,
          parserCodeIdentity: handle.inputEvidence.parserCodeIdentity,
        },
        request(),
      );
      current = {
        repoPath,
        allPaths: [...allPaths],
        scannedFiles: structuredClone(scannedFiles),
        skippedLargeFiles: [],
      };
    } finally {
      result.resolutionContext.clear();
      result.bindingAccumulator.dispose();
      await result.scopeRetention?.dispose();
    }
  }, 60_000);

  afterAll(async () => {
    for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
  });

  async function refuses(
    changed: Candidate,
    inputs = structuredClone(current),
    options = request(),
  ) {
    const before = structuredClone(changed.families);
    await expect(admitScopeRetentionParseReplay(changed, inputs, options)).rejects.toThrow();
    expect(changed.families).toEqual(before);
  }

  it('admits an unchanged live capture without consuming or mutating its families', async () => {
    const loaded = structuredClone(candidate);
    const before = structuredClone(loaded);
    await expect(
      admitScopeRetentionParseReplay(loaded, structuredClone(current), request()),
    ).resolves.toBeUndefined();
    expect(loaded).toEqual(before);
    expect(loaded.manifest.seedReady).toBe(false);
    expect(loaded.manifest.retention.inventory.map((file) => file.filePath)).not.toContain(
      'package.json',
    );
    expect(loaded.manifest.retention.discovery!.allPaths).toContain('package.json');
  }, 60_000);

  it.each(['src/legacy.go', 'script'])(
    'independently refuses unsupported semantics despite claimed complete evidence: %s',
    async (filePath) => {
      const changed = structuredClone(candidate);
      const inputs = structuredClone(current);
      const previous = 'src/legacy.rs';
      inputs.allPaths = inputs.allPaths.map((file) => (file === previous ? filePath : file));
      inputs.scannedFiles = inputs.scannedFiles.map((file) =>
        file.path === previous
          ? { ...file, path: filePath, shebangLanguage: SupportedLanguages.Go }
          : file,
      );
      const retention = changed.manifest.retention;
      Object.assign(retention, {
        inventory: retention.inventory.map((file) =>
          file.filePath === previous ? { ...file, filePath } : file,
        ),
        discovery: {
          ...retention.discovery!,
          allPaths: retention
            .discovery!.allPaths.map((file) => (file === previous ? filePath : file))
            .sort(),
          scanned: retention
            .discovery!.scanned.map((file) =>
              file.path === previous ? { path: filePath, language: SupportedLanguages.Go } : file,
            )
            .sort((a, b) => a.path.localeCompare(b.path)),
        },
      });
      Object.assign(retention.inputEvidence, {
        sources: retention.inputEvidence.sources.map((file) =>
          file.filePath === previous ? { ...file, filePath } : file,
        ),
      });
      const before = structuredClone(changed.families);
      await expect(admitScopeRetentionParseReplay(changed, inputs, request())).rejects.toThrow(
        'unsupported retained language',
      );
      expect(changed.families).toEqual(before);
    },
  );

  it('admits unrelated analysis-pack files and symlinks but refuses catalog changes', async () => {
    const root = path.join(current.repoPath, ANALYSIS_PACKS_ROOT);
    const file = path.join(root, 'fixture.txt');
    const link = path.join(root, 'link');
    const packDirectory = path.join(root, 'x');
    try {
      await expect(
        admitScopeRetentionParseReplay(candidate, current, request()),
      ).resolves.toBeUndefined();
      await fs.writeFile(file, 'changed');
      await expect(
        admitScopeRetentionParseReplay(candidate, current, request()),
      ).resolves.toBeUndefined();
      await fs.symlink('fixture.txt', link);
      await expect(
        admitScopeRetentionParseReplay(candidate, current, request()),
      ).resolves.toBeUndefined();
      await fs.mkdir(packDirectory);
      await fs.writeFile(path.join(packDirectory, 'pack.yml'), 'id: fixture\n');
      await expect(admitScopeRetentionParseReplay(candidate, current, request())).rejects.toThrow(
        'analysis-packs input mismatch',
      );
    } finally {
      await fs.rm(packDirectory, { recursive: true, force: true });
      await fs.rm(link, { force: true });
      await fs.writeFile(file, 'original');
    }
  });

  it.each(['added', 'removed', 'renamed'] as const)('refuses %s JSON discovery', async (mode) => {
    const inputs = structuredClone(current);
    if (mode !== 'added') {
      inputs.allPaths = inputs.allPaths.filter((file) => file !== 'package.json');
      inputs.scannedFiles = inputs.scannedFiles.filter((file) => file.path !== 'package.json');
    }
    if (mode !== 'removed') {
      inputs.allPaths.push('other.json');
      inputs.scannedFiles.push({ path: 'other.json', size: 2 });
    }
    await refuses(structuredClone(candidate), inputs);
  });

  it('refuses changed configuration JSON bytes with unchanged discovery', async () => {
    const filename = path.join(current.repoPath, 'tsconfig.base.json');
    try {
      await fs.writeFile(filename, configContent.replace('"."', '"src"'));
      await refuses(structuredClone(candidate));
    } finally {
      await fs.writeFile(filename, configContent);
    }
  });

  it.each(['unsafe', 'duplicate', 'wrong-language'] as const)(
    'refuses %s retained discovery',
    async (mode) => {
      const changed = structuredClone(candidate);
      const discovery = structuredClone(changed.manifest.retention.discovery!);
      if (mode === 'unsafe')
        Object.assign(discovery, { allPaths: ['../unsafe.json', ...discovery.allPaths.slice(1)] });
      if (mode === 'duplicate')
        Object.assign(discovery, { allPaths: [...discovery.allPaths, discovery.allPaths[0]!] });
      if (mode === 'wrong-language')
        Object.assign(discovery, {
          scanned: discovery.scanned.map((file) => ({ ...file, language: null })),
        });
      Object.assign(changed.manifest.retention, { discovery });
      await refuses(changed);
    },
  );

  it('refuses changed source bytes even when the source length stays the same', async () => {
    const filename = path.join(current.repoPath, 'src/util.ts');
    try {
      await fs.writeFile(filename, sources['src/util.ts'].replace('helper', 'target'));
      await refuses(structuredClone(candidate));
    } finally {
      await fs.writeFile(filename, sources['src/util.ts']);
    }
  }, 60_000);

  it('refuses a newly present previously absent configuration', async () => {
    const filename = path.join(current.repoPath, 'tsconfig.json');
    try {
      await fs.writeFile(filename, '{"compilerOptions":{"baseUrl":"."}}\n');
      await refuses(structuredClone(candidate));
    } finally {
      await fs.unlink(filename);
    }
  }, 60_000);

  it.each(['calls', 'orm-queries', 'graph-nodes'] as const)(
    'refuses incomplete %s producer evidence',
    async (family) => {
      const changed = structuredClone(candidate);
      Object.assign(changed.manifest.retention.producerCompletion, { [family]: false });
      await refuses(changed);
    },
  );

  it.each([null, '0'.repeat(64)])(
    'refuses missing or different parser identity: %s',
    async (parserCodeIdentity) => {
      const changed = structuredClone(candidate);
      Object.assign(changed.manifest.retention.inputEvidence, { parserCodeIdentity });
      await refuses(changed);
    },
    60_000,
  );

  it('refuses a skipped source', async () => {
    const inputs = structuredClone(current);
    inputs.skippedLargeFiles = [{ path: 'src/large.ts', size: 100_000_000 }];
    inputs.allPaths.push('src/large.ts');
    await refuses(structuredClone(candidate), inputs);
  });

  it.each([
    'missing-scan',
    'duplicate-scan',
    'different-scan',
    'missing-all-path',
    'duplicate-all-path',
    'new-source',
  ] as const)('refuses inventory disagreement: %s', async (mode) => {
    const inputs = structuredClone(current);
    if (mode === 'missing-scan') inputs.scannedFiles.pop();
    if (mode === 'duplicate-scan') inputs.scannedFiles.push({ ...inputs.scannedFiles[0]! });
    if (mode === 'different-scan') inputs.scannedFiles[0]!.path = 'src/replaced.ts';
    if (mode === 'missing-all-path') inputs.allPaths.pop();
    if (mode === 'duplicate-all-path') inputs.allPaths.push(inputs.allPaths[0]!);
    if (mode === 'new-source') {
      inputs.allPaths.push('src/new.ts');
      inputs.scannedFiles.push({ path: 'src/new.ts', size: 1 });
    }
    await refuses(structuredClone(candidate), inputs);
  });

  it.each(['missing-source', 'duplicate-source', 'unsafe-source', 'missing-inventory'] as const)(
    'refuses inconsistent retained paths: %s',
    async (mode) => {
      const changed = structuredClone(candidate);
      const evidence = changed.manifest.retention.inputEvidence;
      if (mode === 'missing-source')
        Object.assign(evidence, { sources: evidence.sources.slice(1) });
      if (mode === 'duplicate-source')
        Object.assign(evidence, { sources: [...evidence.sources, evidence.sources[0]!] });
      if (mode === 'unsafe-source')
        Object.assign(evidence, {
          sources: [
            { ...evidence.sources[0]!, filePath: '../outside.ts' },
            ...evidence.sources.slice(1),
          ],
        });
      if (mode === 'missing-inventory')
        Object.assign(changed.manifest.retention, {
          inventory: changed.manifest.retention.inventory.slice(1),
        });
      await refuses(changed);
    },
  );

  it.each(['../outside.ts', '/tmp/outside.ts', 'src/../util.ts', 'src\\util.ts'])(
    'refuses unsafe current paths: %s',
    async (unsafe) => {
      const inputs = structuredClone(current);
      inputs.allPaths[0] = unsafe;
      inputs.scannedFiles[0]!.path = unsafe;
      await refuses(structuredClone(candidate), inputs);
    },
  );

  it('refuses an expired deadline', async () => {
    await refuses(structuredClone(candidate), structuredClone(current), {
      deadline: Date.now() - 1,
    });
  });

  it('refuses an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const changed = structuredClone(candidate);
    const before = structuredClone(changed.families);
    await expect(
      admitScopeRetentionParseReplay(changed, structuredClone(current), {
        ...request(),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancel|abort/i);
    expect(changed.families).toEqual(before);
  });
});
