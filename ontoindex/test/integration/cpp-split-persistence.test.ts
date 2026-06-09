import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/pool-adapter.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';

describe('C++ split declaration persistence', () => {
  const previousOntoIndexHome = process.env.ONTOINDEX_HOME;
  let tempRoot: string | undefined;
  let indexedRepoName: string | undefined;

  afterEach(async () => {
    if (indexedRepoName) {
      await closeLbug(indexedRepoName);
      indexedRepoName = undefined;
    }
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
    if (previousOntoIndexHome === undefined) delete process.env.ONTOINDEX_HOME;
    else process.env.ONTOINDEX_HOME = previousOntoIndexHome;
  });

  it('persists source-first split methods with definition navigation and graph edges', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-cpp-split-persist-'));
    const repoDir = path.join(tempRoot, 'repo');
    const sourceDir = path.join(repoDir, 'src');
    process.env.ONTOINDEX_HOME = path.join(tempRoot, 'gn-home');

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'a.hxx'), 'class A { public: int f(); };\n', 'utf8');
    await fs.writeFile(
      path.join(sourceDir, 'a.cxx'),
      ['#include "a.hxx"', 'int A::f(){ return 1; }', 'int g(){ return A().f(); }', ''].join('\n'),
      'utf8',
    );

    const analysis = await runFullAnalysis(
      repoDir,
      {
        force: true,
        profile: 'symbols',
        includePaths: ['src/a.cxx', 'src/a.hxx'],
        registryName: 'cpp-split-persist',
        skipGit: true,
        skipAgentsMd: true,
        noStats: true,
      },
      {
        onProgress: () => {},
        onLog: () => {},
      },
    );
    indexedRepoName = analysis.repoName;

    const { lbugPath } = getStoragePaths(repoDir);
    await initLbug(indexedRepoName, lbugPath);

    const methods = await executeQuery<{
      filePath: string;
      startLine: number;
      declarationFilePath: string;
      declarationStartLine: number;
      declarationEndLine: number;
      definitionFilePath: string;
      definitionStartLine: number;
      definitionEndLine: number;
    }>(
      indexedRepoName,
      `MATCH (m:Method {name: 'f'})
       RETURN m.filePath AS filePath,
              m.startLine AS startLine,
              m.declarationFilePath AS declarationFilePath,
              m.declarationStartLine AS declarationStartLine,
              m.declarationEndLine AS declarationEndLine,
              m.definitionFilePath AS definitionFilePath,
              m.definitionStartLine AS definitionStartLine,
              m.definitionEndLine AS definitionEndLine`,
    );
    expect(methods).toEqual([
      {
        filePath: 'src/a.cxx',
        startLine: 1,
        declarationFilePath: 'src/a.hxx',
        declarationStartLine: 0,
        declarationEndLine: 0,
        definitionFilePath: 'src/a.cxx',
        definitionStartLine: 1,
        definitionEndLine: 1,
      },
    ]);

    const hasMethodEdges = await executeQuery<{ owner: string; method: string }>(
      indexedRepoName,
      `MATCH (c:Class {name: 'A'})-[r:CodeRelation {type: 'HAS_METHOD'}]->(m:Method {name: 'f'})
       RETURN c.name AS owner, m.name AS method`,
    );
    expect(hasMethodEdges).toEqual([{ owner: 'A', method: 'f' }]);

    const callEdges = await executeQuery<{ caller: string; callee: string }>(
      indexedRepoName,
      `MATCH (g:Function {name: 'g'})-[r:CodeRelation {type: 'CALLS'}]->(m:Method {name: 'f'})
       RETURN g.name AS caller, m.name AS callee`,
    );
    expect(callEdges).toEqual([{ caller: 'g', callee: 'f' }]);
  }, 60_000);

  it('persists macro-decorated C++ classes under the real class name', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-cpp-macro-persist-'));
    const repoDir = path.join(tempRoot, 'repo');
    const sourceDir = path.join(repoDir, 'src');
    process.env.ONTOINDEX_HOME = path.join(tempRoot, 'gn-home');

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, 'gridwin.hxx'),
      [
        '#define SAL_DLLPUBLIC_RTTI',
        'class SAL_DLLPUBLIC_RTTI ScGridWindow : public BaseWindow',
        '{',
        'public:',
        '    void PaintTile(int nCol);',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(sourceDir, 'gridwin4.cxx'),
      [
        '#include "gridwin.hxx"',
        'void ScGridWindow::PaintTile(int nCol) {',
        '  (void)nCol;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const analysis = await runFullAnalysis(
      repoDir,
      {
        force: true,
        profile: 'symbols',
        includePaths: ['src/gridwin4.cxx', 'src/gridwin.hxx'],
        registryName: 'cpp-macro-persist',
        skipGit: true,
        skipAgentsMd: true,
        noStats: true,
      },
      {
        onProgress: () => {},
        onLog: () => {},
      },
    );
    indexedRepoName = analysis.repoName;

    const { lbugPath } = getStoragePaths(repoDir);
    await initLbug(indexedRepoName, lbugPath);

    const classes = await executeQuery<{ name: string; filePath: string }>(
      indexedRepoName,
      `MATCH (c:Class)
       RETURN c.name AS name, c.filePath AS filePath
       ORDER BY c.name`,
    );
    expect(classes).toEqual([{ name: 'ScGridWindow', filePath: 'src/gridwin.hxx' }]);

    const declarationNoise = await executeQuery<{ name: string; filePath: string }>(
      indexedRepoName,
      `MATCH (f:Function {name: 'PaintTile'})
       RETURN f.name AS name, f.filePath AS filePath`,
    );
    expect(declarationNoise).toEqual([]);

    const ownership = await executeQuery<{ owner: string; method: string }>(
      indexedRepoName,
      `MATCH (c:Class {name: 'ScGridWindow'})-[r:CodeRelation {type: 'HAS_METHOD'}]->(m:Method {name: 'PaintTile'})
       RETURN c.name AS owner, m.name AS method`,
    );
    expect(ownership).toEqual([{ owner: 'ScGridWindow', method: 'PaintTile' }]);
  }, 60_000);

  it('persists macro-decorated C++ forward declarations under the real class name', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ontoindex-cpp-forward-persist-'));
    const repoDir = path.join(tempRoot, 'repo');
    const sourceDir = path.join(repoDir, 'src');
    process.env.ONTOINDEX_HOME = path.join(tempRoot, 'gn-home');

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, 'chgtrack.hxx'),
      'class SAL_DLLPUBLIC_RTTI ScChangeActionMove;\n',
      'utf8',
    );

    const analysis = await runFullAnalysis(
      repoDir,
      {
        force: true,
        profile: 'symbols',
        includePaths: ['src/chgtrack.hxx'],
        registryName: 'cpp-forward-persist',
        skipGit: true,
        skipAgentsMd: true,
        noStats: true,
      },
      {
        onProgress: () => {},
        onLog: () => {},
      },
    );
    indexedRepoName = analysis.repoName;

    const { lbugPath } = getStoragePaths(repoDir);
    await initLbug(indexedRepoName, lbugPath);

    const classes = await executeQuery<{ name: string; filePath: string }>(
      indexedRepoName,
      `MATCH (c:Class)
       RETURN c.name AS name, c.filePath AS filePath`,
    );
    expect(classes).toEqual([{ name: 'ScChangeActionMove', filePath: 'src/chgtrack.hxx' }]);
  }, 60_000);
});
