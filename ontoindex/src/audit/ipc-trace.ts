import { executeParameterized } from '../core/lbug/pool-adapter.js';
import type { LbugQueryRow } from '../core/lbug/pool-adapter.js';
import type { AuditResponse, AuditFlowStep } from 'ontoindex-shared';
import path from 'path';
import { scanAuditPatterns } from './scan-engine.js';
import { walkRepositoryPaths } from '../core/ingestion/filesystem-walker.js';

interface IPCTraceOptions {
  repoId: string;
  repoPath: string;
  symbolName: string;
}

type SymbolLocationRow = LbugQueryRow & {
  readonly filePath: string;
  readonly startLine: number;
  readonly labels: unknown;
  readonly id?: string;
  readonly 0?: string;
  readonly 1?: number;
  readonly 2?: unknown;
};

type SymbolNameRow = LbugQueryRow & {
  readonly name: string;
  readonly startLine: number;
  readonly labels?: unknown;
  readonly 0?: string;
  readonly 1?: number;
};

function firstString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Trace execution flows across the JS-to-C++ bridge.
 */
export async function traceIPCBridges(options: IPCTraceOptions): Promise<AuditResponse> {
  const { repoId, repoPath, symbolName } = options;
  const flow: AuditFlowStep[] = [];

  // 1. Find JS call sites and exports for this symbol
  const jsResults = await executeParameterized<SymbolLocationRow>(
    repoId,
    `MATCH (n) WHERE n.name = $name 
     RETURN n.filePath as filePath, n.startLine as startLine, labels(n) as labels, n.id as id`,
    { name: symbolName },
  );

  for (const res of jsResults) {
    const labels = Array.isArray(res.labels) ? res.labels : [res.labels || res[2] || 'Symbol'];
    const label = firstString(labels[0], 'Symbol');
    flow.push({
      kind: `JS ${label}`,
      file: res.filePath || res[0] || '',
      line: (res.startLine ?? res[1]) || 1,
      detail: `JavaScript definition/export of "${symbolName}"`,
      confidence: 'high',
    });
  }

  // 2. Identify "Bridge" files (JS files that load .node modules)
  // We'll scan for common patterns: require('*.node') or import native from '*.node'
  const scannedFiles = await walkRepositoryPaths(repoPath);
  const bridgeFiles = scannedFiles
    .filter((f) => f.path.endsWith('.js') || f.path.endsWith('.ts'))
    .map((f) => path.join(repoPath, f.path));

  const bridgeScan = await scanAuditPatterns({
    files: bridgeFiles,
    patterns: [
      { id: 'node_require', kind: 'regex', expression: 'require\\s*\\(.*\\.node' },
      { id: 'node_import', kind: 'regex', expression: 'from\\s*.*\\.node' },
    ],
  });

  const activeBridges = new Set(bridgeScan.hits.map((h) => h.file));
  for (const bridgeFile of activeBridges) {
    // If the bridge file mentions our symbol, it's a strong candidate
    const relBridgePath = path.relative(repoPath, bridgeFile);
    if (flow.some((f) => f.file === relBridgePath)) {
      const bridgeFlowIndex = flow.findIndex((f) => f.file === relBridgePath);
      flow[bridgeFlowIndex].kind = 'JS Bridge';
      flow[bridgeFlowIndex].detail = `Native bridge file loading a .node module`;
      flow[bridgeFlowIndex].confidence = 'high';
    }
  }

  // 3. Search C++ files for the N-API registration of this symbol
  const cppFiles = scannedFiles
    .filter((f) => f.path.endsWith('.cc') || f.path.endsWith('.cpp') || f.path.endsWith('.h'))
    .map((f) => path.join(repoPath, f.path));

  if (cppFiles.length > 0) {
    const cppScan = await scanAuditPatterns({
      files: cppFiles,
      patterns: [
        {
          id: 'napi_reg',
          kind: 'regex',
          expression: `napi_set_named_property\\s*\\(.*["']${symbolName}["']`,
        },
        {
          id: 'napi_fn',
          kind: 'regex',
          expression: `napi_create_function\\s*\\(.*${symbolName}`,
        },
      ],
    });

    for (const hit of cppScan.hits) {
      flow.push({
        kind: 'C++ Registration',
        file: path.relative(repoPath, hit.file),
        line: hit.line,
        detail: `Node-API registration site for "${symbolName}"`,
        confidence: 'high',
      });

      // 4. Try to find the actual C++ implementation function name
      // Query ALL nodes in the file and look for one containing symbolName (heuristic)
      const cppSymbols = await executeParameterized<SymbolNameRow>(
        repoId,
        `MATCH (n) WHERE n.filePath = $file 
         RETURN n.name as name, n.startLine as startLine, labels(n) as labels`,
        { file: path.relative(repoPath, hit.file) },
      );

      // Find function that looks like an implementation (mentions symbolName or is defined near)
      const implementation = cppSymbols.find((s) => {
        const name = (s.name || s[0] || '').toLowerCase();
        const target = symbolName.toLowerCase();
        return name.includes(target);
      });

      if (implementation) {
        flow.push({
          kind: 'C++ Implementation',
          file: path.relative(repoPath, hit.file),
          line: implementation.startLine || implementation[1],
          detail: `Actual C++ implementation function: "${implementation.name || implementation[0]}" (found via heuristic name match)`,
          confidence: 'medium',
        });
      }
    }
  }

  return {
    summary:
      flow.length > 0
        ? `Successfully traced IPC bridge for "${symbolName}" across ${flow.length} steps`
        : `No IPC bridge traces found for "${symbolName}"`,
    flow,
  };
}
