import { describe, it, expect, vi, afterEach } from 'vitest';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
const { execFileText } = vi.hoisted(() => ({ execFileText: vi.fn() }));

vi.mock('../../src/core/process/exec-file.js', () => ({ execFileText }));

import { gitMiningPhase } from '../../src/core/ingestion/pipeline-phases/git-mining.js';

function createGraph(overrides: Partial<KnowledgeGraph> = {}): KnowledgeGraph {
  return {
    nodes: [],
    relationships: [],
    iterNodes: function* () {},
    iterRelationships: function* () {},
    forEachNode: vi.fn(),
    forEachRelationship: vi.fn(),
    getNode: vi.fn(() => undefined),
    nodeCount: 0,
    relationshipCount: 0,
    addNode: vi.fn(),
    addRelationship: vi.fn(),
    removeNode: vi.fn(() => false),
    removeNodesByFile: vi.fn(() => 0),
    removeRelationship: vi.fn(() => false),
    ...overrides,
  };
}

describe('gitMiningPhase', () => {
  afterEach(() => {
    execFileText.mockReset();
    vi.restoreAllMocks();
  });

  it('runs git probes and log mining through bounded async execFile calls', async () => {
    execFileText
      .mockResolvedValueOnce('git version 2.0.0\n')
      .mockResolvedValueOnce('/repo\n')
      .mockResolvedValueOnce('abc123\nsrc/a.ts\nsrc/b.ts\n\n')
      .mockResolvedValueOnce('');

    const deps = new Map([
      [
        'scan',
        {
          phaseName: 'scan',
          durationMs: 0,
          output: {
            scannedFiles: [],
            allPaths: ['src/a.ts', 'src/b.ts'],
            totalFiles: 2,
          },
        },
      ],
    ]);

    const result = await gitMiningPhase.execute(
      {
        repoPath: '/repo',
        graph: createGraph(),
        onProgress: vi.fn(),
        pipelineStart: Date.now(),
      },
      deps,
    );

    expect((result as { status: string }).status).toBe('success');
    expect(execFileText).toHaveBeenCalledWith(
      'git',
      ['--version'],
      expect.objectContaining({ timeoutMs: 3000, maxBuffer: 64 * 1024 }),
    );
    expect(execFileText).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--show-toplevel'],
      expect.objectContaining({ cwd: '/repo', timeoutMs: 3000 }),
    );
    expect(execFileText).toHaveBeenCalledWith(
      'git',
      [
        'log',
        '--since=12 months ago',
        '--name-only',
        '--pretty=format:%H',
        '--skip=0',
        '-n',
        '200',
      ],
      expect.objectContaining({ cwd: '/repo', timeoutMs: 15000, maxBuffer: 10 * 1024 * 1024 }),
    );
  }, 60_000);

  it('logs chunk failures with the thrown message and continues mining later chunks', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    execFileText
      .mockResolvedValueOnce('git version 2.0.0\n')
      .mockResolvedValueOnce('/repo\n')
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValueOnce('');

    const result = await gitMiningPhase.execute(
      {
        repoPath: '/repo',
        graph: createGraph({
          getNode: vi.fn(() => undefined),
          addRelationship: vi.fn(),
        }),
        onProgress: vi.fn(),
        pipelineStart: Date.now(),
      },
      new Map([
        [
          'scan',
          {
            phaseName: 'scan',
            durationMs: 0,
            output: {
              scannedFiles: [],
              allPaths: ['src/a.ts', 'src/b.ts'],
              totalFiles: 2,
            },
          },
        ],
      ]),
    );

    expect((result as { status: string }).status).toBe('success');
    expect(warn).toHaveBeenCalledWith('[gitMining] chunk skip=0 failed: chunk failed');
    expect(execFileText).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['--skip=200']),
      expect.objectContaining({ cwd: '/repo' }),
    );
  }, 60_000);

  it('preserves Map maximum size detection and failed reason from outer errors', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    execFileText
      .mockResolvedValueOnce('git version 2.0.0\n')
      .mockResolvedValueOnce('/repo\n')
      .mockResolvedValueOnce(
        ['c1\nsrc/a.ts\nsrc/b.ts', 'c2\nsrc/a.ts\nsrc/b.ts', 'c3\nsrc/a.ts\nsrc/b.ts', ''].join(
          '\n\n',
        ),
      )
      .mockResolvedValueOnce('');

    const result = await gitMiningPhase.execute(
      {
        repoPath: '/repo',
        graph: createGraph({
          getNode: vi.fn(() => {
            throw new Error('Map maximum size exceeded');
          }),
          addRelationship: vi.fn(),
        }),
        onProgress: vi.fn(),
        pipelineStart: Date.now(),
      },
      new Map([
        [
          'scan',
          {
            phaseName: 'scan',
            durationMs: 0,
            output: {
              scannedFiles: [],
              allPaths: ['src/a.ts', 'src/b.ts'],
              totalFiles: 2,
            },
          },
        ],
      ]),
    );

    expect(result).toEqual({ status: 'failed', reason: 'Map maximum size exceeded' });
    expect(error).toHaveBeenCalledWith(
      '[gitMining] Map maximum size exceeded — corpus too large for chunked collection.',
    );
    expect(error).toHaveBeenCalledWith('[gitMining] Failed: Map maximum size exceeded');
  });
});
