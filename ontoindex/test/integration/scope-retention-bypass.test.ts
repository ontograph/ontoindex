import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLanguageFromFilename } from 'ontoindex-shared';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import * as parseImplementation from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import {
  copyScopeRetentionCandidate,
  persistScopeRetentionCandidate,
} from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate.js';
import { loadScopeRetentionCandidate } from '../../src/core/ingestion/pipeline-phases/scope-retention-candidate-reader.js';

function snapshot(graph: KnowledgeGraph) {
  return {
    nodes: structuredClone(graph.nodes).sort((left, right) => left.id.localeCompare(right.id)),
    relationships: structuredClone(graph.relationships).sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

const fixtures: Array<{ language: string; files: Record<string, string>; primaryFlag?: string }> = [
  {
    language: 'typescript',
    primaryFlag: 'REGISTRY_PRIMARY_TYPESCRIPT',
    files: {
      'src/main.ts':
        [
          'function target() {}',
          'function invoke() { target(); }',
          'function shadowOnly(target) { target(); }',
          'function wrongArityOnly() { target(1); }',
        ].join('\n') + '\n',
    },
  },
  {
    language: 'javascript',
    primaryFlag: 'REGISTRY_PRIMARY_JAVASCRIPT',
    files: {
      'src/main.js':
        [
          'function target() {}',
          'function invoke() { target(); }',
          'function shadowOnly(target) { target(); }',
          'function wrongArityOnly() { target(1); }',
        ].join('\n') + '\n',
    },
  },
  {
    language: 'typescript imports',
    files: {
      'src/util.ts': 'export function helper() {}\n',
      'src/main.ts': "import { helper } from './util';\nexport function entry() { helper(); }\n",
    },
  },
  {
    language: 'javascript imports',
    files: {
      'src/util.js': 'export function helper() {}\n',
      'src/main.js': "import { helper } from './util';\nexport function entry() { helper(); }\n",
    },
  },
  {
    language: 'cpp',
    files: {
      'src/first.cpp': 'void first() { first(); return; }\nvoid second() { first(); second(); }\n',
      'src/other.cpp': 'void other() { other(); return; }\nvoid entry() { other(); entry(); }\n',
    },
  },
  {
    language: 'rust',
    files: {
      'src/first.rs':
        'pub fn first() { second(); first(); return; }\nfn second() { first(); second(); }\n',
      'src/other.rs':
        'pub fn other() { entry(); other(); return; }\nfn entry() { other(); entry(); }\n',
    },
  },
  {
    language: 'python',
    files: {
      'src/first.py': 'def first():\n    first()\ndef second():\n    first()\nsecond()\n',
      'src/other.py': 'def other():\n    other()\ndef entry():\n    other()\nentry()\n',
    },
  },
];

describe.sequential('real scope-retention parser bypass', () => {
  const directories: string[] = [];
  const request = () => ({
    deadline: Date.now() + 60_000,
    artifactAllowance: { remainingBytes: 64 * 1024 * 1024 },
  });
  const temporaryDirectory = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-retention-bypass-'));
    directories.push(directory);
    return directory;
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0))
      fs.rmSync(directory, { recursive: true, force: true });
  });

  async function capture(files: Record<string, string>) {
    const repository = temporaryDirectory();
    const generation = temporaryDirectory();
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
      fs.writeFileSync(path.join(repository, file), content);
    }
    let expected: Parameters<typeof loadScopeRetentionCandidate>[1] | undefined;
    const result = await runPipelineFromRepo(repository, () => {}, {
      skipGraphPhases: true,
      skipWorkers: true,
      scopeRetention: {
        ...request(),
        consume: async (handle) => {
          const identity = {
            sourceManifestDigest: 'a'.repeat(64),
            targetCommit: 'head',
            baseGenerationId: null,
          };
          expected = { identity, parserCodeIdentity: handle.inputEvidence.parserCodeIdentity };
          const manifest = await persistScopeRetentionCandidate(
            handle,
            generation,
            identity,
            request(),
          );
          // Exercise real complete candidates; never repair retained evidence in the test.
          expect(manifest.coverage.complete).toBe(true);
          expect(
            [...handle.inventory].sort((left, right) =>
              left.filePath.localeCompare(right.filePath),
            ),
          ).toEqual(
            Object.keys(files)
              .filter((filePath) => getLanguageFromFilename(filePath))
              .sort()
              .map((filePath) => ({ filePath, status: 'retained' })),
          );
          expect(manifest.retention.inputEvidence.complete).toBe(true);
          expect(manifest.retention.graphNodesCaptured).toBe(true);
          expect(manifest.retention.graphRelationshipsCaptured).toBe(true);
        },
      },
    });
    expect(expected).toBeDefined();
    const candidate = await loadScopeRetentionCandidate(generation, expected!, request());
    return { repository, generation, expected: expected!, result, candidate };
  }

  it.each(fixtures)(
    '$language bypass survives promotion into the next generation',
    async (fixture) => {
      if (fixture.primaryFlag) {
        vi.stubEnv(fixture.primaryFlag, '1');
        vi.stubEnv('INGESTION_EMIT_SCOPES', '0');
      }
      const first = await capture(fixture.files);
      const expectedGraph = snapshot(first.result.graph);
      const parser = vi.spyOn(parseImplementation, 'runChunkedParseAndResolve');
      const promotedGeneration = temporaryDirectory();
      const preserve = vi.fn(async () => {
        await copyScopeRetentionCandidate(
          first.generation,
          promotedGeneration,
          first.expected,
          request(),
        );
      });
      const second = await runPipelineFromRepo(first.repository, () => {}, {
        skipGraphPhases: true,
        skipWorkers: true,
        scopeReplay: { candidate: first.candidate, request: request(), preserve },
      });
      expect(parser).not.toHaveBeenCalled();
      expect(preserve).toHaveBeenCalledTimes(1);
      expect(snapshot(second.graph)).toEqual(expectedGraph);

      const promoted = await loadScopeRetentionCandidate(
        promotedGeneration,
        first.expected,
        request(),
      );
      expect(promoted.manifest).toEqual(first.candidate.manifest);
      const thirdGeneration = temporaryDirectory();
      const preserveAgain = vi.fn(async () => {
        await copyScopeRetentionCandidate(
          promotedGeneration,
          thirdGeneration,
          first.expected,
          request(),
        );
      });
      const third = await runPipelineFromRepo(first.repository, () => {}, {
        skipGraphPhases: true,
        skipWorkers: true,
        scopeReplay: { candidate: promoted, request: request(), preserve: preserveAgain },
      });
      expect(parser).not.toHaveBeenCalled();
      expect(preserveAgain).toHaveBeenCalledTimes(1);
      expect(snapshot(third.graph)).toEqual(expectedGraph);
      expect(
        (await loadScopeRetentionCandidate(thirdGeneration, first.expected, request())).manifest,
      ).toEqual(first.candidate.manifest);

      if (fixture.primaryFlag) {
        const graph = third.graph;
        const functionNode = (name: string) =>
          graph.nodes.find(
            ({ label, properties }) =>
              label === 'Function' &&
              properties.filePath === Object.keys(fixture.files)[0] &&
              properties.name === name,
          );
        const target = functionNode('target');
        const invoke = functionNode('invoke');
        const shadowOnly = functionNode('shadowOnly');
        const wrongArityOnly = functionNode('wrongArityOnly');
        expect(target).toBeDefined();
        expect(invoke).toBeDefined();
        expect(shadowOnly).toBeDefined();
        expect(wrongArityOnly).toBeDefined();
        const targetCalls = graph.relationships.filter(
          (edge) => edge.type === 'CALLS' && edge.targetId === target!.id,
        );
        expect(
          targetCalls.some(
            (edge) => edge.sourceId === invoke!.id && edge.reason?.startsWith('scope-resolution:'),
          ),
        ).toBe(true);
        expect(targetCalls.some((edge) => edge.sourceId === shadowOnly!.id)).toBe(false);
        expect(targetCalls.some((edge) => edge.sourceId === wrongArityOnly!.id)).toBe(false);
      }
    },
  );

  it.each(['source change', 'new tsconfig'] as const)(
    '%s falls back once and matches a fresh parse',
    async (change) => {
      const first = await capture(
        fixtures.find(({ files }) => files['src/util.ts'] !== undefined)!.files,
      );
      if (change === 'source change') {
        fs.appendFileSync(
          path.join(first.repository, 'src/main.ts'),
          'export function added() { entry(); }\n',
        );
      } else {
        fs.writeFileSync(
          path.join(first.repository, 'tsconfig.json'),
          '{"compilerOptions":{"baseUrl":"."}}\n',
        );
      }
      const parser = vi.spyOn(parseImplementation, 'runChunkedParseAndResolve');
      const preserve = vi.fn(async () => {});
      const fallback = await runPipelineFromRepo(first.repository, () => {}, {
        skipGraphPhases: true,
        skipWorkers: true,
        scopeReplay: { candidate: first.candidate, request: request(), preserve },
      });
      expect(parser).toHaveBeenCalledTimes(1);
      expect(preserve).not.toHaveBeenCalled();
      parser.mockClear();
      const fresh = await runPipelineFromRepo(first.repository, () => {}, {
        skipGraphPhases: true,
        skipWorkers: true,
      });
      expect(parser).toHaveBeenCalledTimes(1);
      expect(snapshot(fallback.graph)).toEqual(snapshot(fresh.graph));
    },
  );

  describe('native configuration recovery', () => {
    const nativeFixtures: Array<{
      language: string;
      files: Record<string, string>;
      changes: Array<{ file: string; edited: string }>;
    }> = [
      {
        language: 'Python',
        files: {
          'src/main.py': 'def helper():\n    pass\ndef entry():\n    helper()\n',
          'src/util.py': 'def helper():\n    return 1\n',
          'pyproject.toml': '[tool.setuptools]\npackage-dir = {"" = "src"}\n',
          'setup.cfg': '[options]\npackage_dir =\n    = src\n',
        },
        changes: [
          { file: 'pyproject.toml', edited: '[tool.setuptools]\npackage-dir = {"" = "."}\n' },
          { file: 'setup.cfg', edited: '[options]\npackage_dir =\n    = .\n' },
        ],
      },
      {
        language: 'C++',
        files: {
          'src/main.cpp': 'void helper() {}\nvoid entry() { helper(); }\n',
          'src/util.h': 'void header_helper() {}\n',
          'src/util.cpp': 'void helper() {}\n',
          'compile_commands.json':
            '[{"directory":".","file":"src/main.cpp","arguments":["c++","-Isrc","-c","src/main.cpp"]}]\n',
          'CMakeLists.txt':
            'cmake_minimum_required(VERSION 3.16)\nproject(fixture)\nadd_executable(fixture src/main.cpp src/util.cpp)\n',
        },
        changes: [
          {
            file: 'compile_commands.json',
            edited:
              '[{"directory":".","file":"src/main.cpp","arguments":["c++","-I.","-c","src/main.cpp"]}]\n',
          },
          {
            file: 'CMakeLists.txt',
            edited:
              'cmake_minimum_required(VERSION 3.16)\nproject(fixture)\nadd_executable(fixture src/main.cpp src/util.cpp)\ntarget_include_directories(fixture PRIVATE src)\n',
          },
        ],
      },
      {
        language: 'Rust',
        files: {
          'src/main.rs': 'fn main() { helper(); }\nfn helper() {}\n',
          'crates/a/src/lib.rs': 'pub fn helper() {}\n',
          'Cargo.toml':
            '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n[[bin]]\nname = "fixture"\npath = "src/main.rs"\n[workspace]\nmembers = ["crates/a"]\n',
          'crates/a/Cargo.toml':
            '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "src/lib.rs"\n',
        },
        changes: [
          {
            file: 'Cargo.toml',
            edited:
              '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n[[bin]]\nname = "fixture"\npath = "src/./main.rs"\n[workspace]\nmembers = ["crates/*"]\n',
          },
          {
            file: 'crates/a/Cargo.toml',
            edited:
              '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "src/./lib.rs"\n',
          },
        ],
      },
    ];

    for (const fixture of nativeFixtures) {
      it.each(fixture.changes)(
        `${fixture.language} $file edit/delete refuse replay and exact restoration admits it`,
        async (change) => {
          const first = await capture(fixture.files);
          const baseline = snapshot(first.result.graph);
          const filename = path.join(first.repository, change.file);
          const original = fs.readFileSync(filename);
          const parser = vi.spyOn(parseImplementation, 'runChunkedParseAndResolve');
          const preserve = vi.fn(async () => {});

          for (const mutation of ['edit', 'delete'] as const) {
            if (mutation === 'edit') fs.writeFileSync(filename, change.edited);
            else fs.unlinkSync(filename);
            parser.mockClear();
            preserve.mockClear();
            const fallback = await runPipelineFromRepo(first.repository, () => {}, {
              skipGraphPhases: true,
              skipWorkers: true,
              scopeReplay: { candidate: first.candidate, request: request(), preserve },
            });
            expect(parser, `${mutation}: parser fallback`).toHaveBeenCalledTimes(1);
            expect(preserve, `${mutation}: no replay preservation`).not.toHaveBeenCalled();
            parser.mockClear();
            const fresh = await runPipelineFromRepo(first.repository, () => {}, {
              skipGraphPhases: true,
              skipWorkers: true,
            });
            expect(parser).toHaveBeenCalledTimes(1);
            expect(snapshot(fallback.graph)).toEqual(snapshot(fresh.graph));
          }

          fs.writeFileSync(filename, original);
          // Reload the original generation so restoration must pass a new admission check.
          const restoredCandidate = await loadScopeRetentionCandidate(
            first.generation,
            first.expected,
            request(),
          );
          parser.mockClear();
          preserve.mockClear();
          const restored = await runPipelineFromRepo(first.repository, () => {}, {
            skipGraphPhases: true,
            skipWorkers: true,
            scopeReplay: { candidate: restoredCandidate, request: request(), preserve },
          });
          expect(parser).not.toHaveBeenCalled();
          expect(preserve).toHaveBeenCalledTimes(1);
          expect(snapshot(restored.graph)).toEqual(baseline);
        },
      );
    }
  });
});
