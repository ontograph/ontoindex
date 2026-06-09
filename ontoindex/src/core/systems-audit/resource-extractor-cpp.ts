import {
  createSourceEvidence,
  type ResourceEvent,
  type ResourceFact,
  type ResourceHandle,
  type ResourceInstance,
} from './resource-facts.js';
import {
  createSystemsAuditRecord,
  type SystemsAuditFinding,
  type SystemsAuditRecord,
} from './systems-audit-contracts.js';

export const CPP_POSIX_RESOURCE_ANALYZER_ID = 'cpp-posix-resource-extractor';
export const CPP_POSIX_RESOURCE_ANALYZER_VERSION = '0.1.0';

export interface ExtractCppPosixResourceFactsInput {
  source: string;
  filePath: string;
  fileHash: string;
  sourceIndexId: string;
  sourceCommitHash: string;
  graphSchemaVersion?: number;
  processIdentity?: string;
  maxRecords?: number;
}

interface MutableState {
  facts: ResourceFact[];
  findings: SystemsAuditFinding[];
  warnings: string[];
  skipReasons: string[];
  handlesByName: Map<string, ResourceHandle>;
  pipeGroups: {
    localName: string;
    read: string;
    write: string;
    atomicCloexec: boolean;
    line: number;
    evidenceSnippet: string;
  }[];
  sequence: number;
}

export function extractCppPosixResourceFacts(
  input: ExtractCppPosixResourceFactsInput,
): SystemsAuditRecord {
  const maxRecords = input.maxRecords ?? 500;
  const processIdentity = input.processIdentity ?? 'process:local';
  const state: MutableState = {
    facts: [],
    findings: [],
    warnings: [],
    skipReasons: [],
    handlesByName: new Map(),
    pipeGroups: [],
    sequence: 0,
  };

  const lines = stripBlockComments(input.source).split('\n');
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = stripLineComment(rawLine).trim();
    if (line.length === 0) return;

    extractOpen(line, lineNumber, input.filePath, processIdentity, state);
    extractSocket(line, lineNumber, input.filePath, processIdentity, state);
    extractPipe(line, lineNumber, input.filePath, processIdentity, state);
    extractDup(line, lineNumber, input.filePath, processIdentity, state);
    extractFcntlCloexec(line, lineNumber, input.filePath, processIdentity, state);
    extractClose(line, lineNumber, input.filePath, processIdentity, state);
    extractFork(line, lineNumber, input.filePath, processIdentity, state);
    extractExec(line, lineNumber, input.filePath, processIdentity, state);
    extractWaitpid(line, lineNumber, input.filePath, processIdentity, state);
    extractPidfd(line, lineNumber, input.filePath, processIdentity, state);
    extractUnsupported(line, lineNumber, input.filePath, processIdentity, state);
    extractWrapperHiddenOwnership(line, lineNumber, input.filePath, processIdentity, state);
  });

  finalizePipeFindings(input.filePath, processIdentity, state);

  const truncated = state.facts.length > maxRecords;
  const facts = truncated ? state.facts.slice(0, maxRecords) : state.facts;
  if (truncated)
    state.warnings.push(
      `systems-audit facts truncated from ${state.facts.length} to ${maxRecords}`,
    );

  return createSystemsAuditRecord({
    sourceIndexId: input.sourceIndexId,
    sourceCommitHash: input.sourceCommitHash,
    analyzerId: CPP_POSIX_RESOURCE_ANALYZER_ID,
    analyzerVersion: CPP_POSIX_RESOURCE_ANALYZER_VERSION,
    filePath: input.filePath,
    fileHash: input.fileHash,
    graphSchemaVersion: input.graphSchemaVersion,
    status:
      state.skipReasons.length > 0 ||
      state.findings.some((finding) => finding.status === 'unresolved')
        ? 'partial'
        : 'complete',
    confidence: 0.78,
    evidence: facts.flatMap((fact) => fact.evidence),
    records: facts,
    findings: state.findings,
    limits: { maxRecords, recordsReturned: facts.length, truncated },
    skipReasons: state.skipReasons,
    warnings: state.warnings,
  });
}

function extractOpen(
  line: string,
  lineNumber: number,
  filePath: string,
  processIdentity: string,
  state: MutableState,
): void {
  const match = line.match(
    /(?:^|[=,\s])(?:(?:int|auto)\s+)?([A-Za-z_]\w*)\s*=\s*open(?:at)?\s*\((.*)\)/,
  );
  if (!match) return;
  const localName = match[1];
  const args = match[2] ?? '';
  const closeOnExec = /\bO_CLOEXEC\b/.test(args) ? 'yes' : 'unknown';
  const resource = pushInstance(
    state,
    'file',
    'open',
    processIdentity,
    filePath,
    lineNumber,
    line,
    {
      path: firstStringLiteral(args),
    },
  );
  pushHandle(
    state,
    localName,
    'fd',
    resource.resourceInstanceId,
    processIdentity,
    filePath,
    lineNumber,
    line,
    closeOnExec,
  );
  pushEvent(
    state,
    'allocate',
    'open',
    processIdentity,
    filePath,
    lineNumber,
    line,
    [handleId(processIdentity, localName)],
    resource.resourceInstanceId,
    'complete',
    [],
  );
}

function extractSocket(
  line: string,
  lineNumber: number,
  filePath: string,
  processIdentity: string,
  state: MutableState,
): void {
  const match = line.match(
    /(?:^|[=,\s])(?:(?:int|auto)\s+)?([A-Za-z_]\w*)\s*=\s*socket\s*\((.*)\)/,
  );
  if (!match) return;
  const localName = match[1];
  const args = match[2] ?? '';
  const closeOnExec = /\bSOCK_CLOEXEC\b/.test(args) ? 'yes' : 'unknown';
  const resource = pushInstance(
    state,
    'socket',
    'socket',
    processIdentity,
    filePath,
    lineNumber,
    line,
    {
      domain: args.split(',')[0]?.trim(),
    },
  );
  pushHandle(
    state,
    localName,
    'fd',
    resource.resourceInstanceId,
    processIdentity,
    filePath,
    lineNumber,
    line,
    closeOnExec,
  );
  pushEvent(
    state,
    'allocate',
    'socket',
    processIdentity,
    filePath,
    lineNumber,
    line,
    [handleId(processIdentity, localName)],
    resource.resourceInstanceId,
    'complete',
    [],
  );
}

function extractPipe(
  line: string,
  lineNumber: number,
  filePath: string,
  processIdentity: string,
  state: MutableState,
): void {
  const match = line.match(/\b(pipe2|pipe)\s*\(\s*([A-Za-z_]\w*)\s*(?:,\s*([^)]*))?\)/);
  if (!match || (match[1] !== 'pipe' && match[1] !== 'pipe2')) return;
  const mechanism = match[1];
  const localName = match[2];
  const flags = match[3] ?? '';
  const atomicCloexec = mechanism === 'pipe2' && /\bO_CLOEXEC\b/.test(flags);
  const resource = pushInstance(
    state,
    'pipe',
    mechanism,
    processIdentity,
    filePath,
    lineNumber,
    line,
    {
      descriptor: localName,
    },
  );
  const readName = `${localName}[0]`;
  const writeName = `${localName}[1]`;
  pushHandle(
    state,
    readName,
    'fd',
    resource.resourceInstanceId,
    processIdentity,
    filePath,
    lineNumber,
    line,
    atomicCloexec ? 'yes' : 'no',
  );
  pushHandle(
    state,
    writeName,
    'fd',
    resource.resourceInstanceId,
    processIdentity,
    filePath,
    lineNumber,
    line,
    atomicCloexec ? 'yes' : 'no',
  );
  pushEvent(
    state,
    'allocate',
    mechanism,
    processIdentity,
    filePath,
    lineNumber,
    line,
    [handleId(processIdentity, readName), handleId(processIdentity, writeName)],
    resource.resourceInstanceId,
    'complete',
    [],
  );
  state.pipeGroups.push({
    localName,
    read: readName,
    write: writeName,
    atomicCloexec,
    line: lineNumber,
    evidenceSnippet: line,
  });
}

function extractDup(
  line: string,
  lineNumber: number,
  filePath: string,
  processIdentity: string,
  state: MutableState,
): void {
  const dupMatch = line.match(
    /(?:^|[=,\s])(?:(?:int|auto)\s+)?([A-Za-z_]\w*)\s*=\s*dup\s*\(\s*([^,)]+)\s*\)/,
  );
  const dup2Match = line.match(/\bdup([23])\s*\(\s*([^,]+)\s*,\s*([^,)]+)(?:,\s*([^)]*))?\)/);
  if (!dupMatch && !dup2Match) return;
  const target = dupMatch ? dupMatch[1] : normalizeHandleName(dup2Match?.[3] ?? 'unresolved');
  const source = normalizeHandleName(dupMatch ? dupMatch[2] : (dup2Match?.[2] ?? 'unresolved'));
  const sourceHandle = state.handlesByName.get(source);
  const closeOnExec =
    dup2Match?.[1] === '3' && /\bO_CLOEXEC\b/.test(dup2Match[4] ?? '') ? 'yes' : 'unknown';
  const unresolved = sourceHandle ? [] : ['duplicate source handle unresolved'];
  pushHandle(
    state,
    target,
    'fd',
    sourceHandle?.resourceInstanceId,
    processIdentity,
    filePath,
    lineNumber,
    line,
    closeOnExec,
    unresolved,
  );
  pushEvent(
    state,
    'duplicate',
    dupMatch ? 'dup' : `dup${dup2Match?.[1]}`,
    processIdentity,
    filePath,
    lineNumber,
    line,
    [handleId(processIdentity, source), handleId(processIdentity, target)],
    sourceHandle?.resourceInstanceId,
    sourceHandle ? 'complete' : 'unresolved',
    unresolved,
  );
}

function extractFcntlCloexec(
  line: string,
  lineNumber: number,
  filePath: string,
  processIdentity: string,
  state: MutableState,
): void {
  const match = line.match(/\bfcntl\s*\(\s*([^,]+),\s*([^,]+),\s*([^)]*\bFD_CLOEXEC\b[^)]*)\)/);
  if (!match) return;
  const localName = normalizeHandleName(match[1] ?? 'unresolved');
  const existing = state.handlesByName.get(localName);
  if (existing) {
    existing.closeOnExec = 'yes';
  }
  const unresolved = existing ? [] : ['fcntl target handle unresolved'];
  pushEvent(
    state,
    'set-cloexec',
    'fcntl',
    processIdentity,
    filePath,
    lineNumber,
    line,
    [handleId(processIdentity, localName)],
    existing?.resourceInstanceId,
    existing ? 'complete' : 'unresolved',
    unresolved,
  );
}

function extractClose(
  line: string,
  lineNumber: number,
  filePath: string,
  processIdentity: string,
  state: MutableState,
): void {
  const match = line.match(/\bclose\s*\(\s*([^)]+)\)/);
  if (!match) return;
  const localName = normalizeHandleName(match[1] ?? 'unresolved');
  const handle = state.handlesByName.get(localName);
  const unresolved = handle ? [] : ['close target handle unresolved'];
  pushEvent(
    state,
    'release',
    'close',
    processIdentity,
    filePath,
    lineNumber,
    line,
    [handleId(processIdentity, localName)],
    handle?.resourceInstanceId,
    handle ? 'complete' : 'unresolved',
    unresolved,
  );
}

function extractFork(
  line: string,
  lineNumber: number,
  filePath: string,
  processIdentity: string,
  state: MutableState,
): void {
  if (!/\bfork\s*\(/.test(line)) return;
  const openHandles = Array.from(state.handlesByName.values()).filter(
    (handle) => handle.ownership === 'owned',
  );
  pushEvent(
    state,
    'fork',
    'fork',
    processIdentity,
    filePath,
    lineNumber,
    line,
    openHandles.map((handle) => handle.handleId),
    undefined,
    openHandles.length > 0 ? 'partial' : 'complete',
    openHandles.length > 0 ? ['fork child inherits currently open process-local handles'] : [],
  );
}

function extractExec(
  line: string,
  lineNumber: number,
  filePath: string,
  processIdentity: string,
  state: MutableState,
): void {
  if (!/\bexec(?:l|le|lp|v|ve|vp|vpe)?\s*\(/.test(line)) return;
  const preserved = Array.from(state.handlesByName.values()).filter(
    (handle) => handle.closeOnExec !== 'yes',
  );
  pushEvent(
    state,
    'exec',
    'exec',
    processIdentity,
    filePath,
    lineNumber,
    line,
    preserved.map((handle) => handle.handleId),
    undefined,
    preserved.length > 0 ? 'partial' : 'complete',
    preserved.length > 0 ? ['exec may preserve handles without confirmed close-on-exec'] : [],
  );
}

function extractWaitpid(
  line: string,
  lineNumber: number,
  filePath: string,
  processIdentity: string,
  state: MutableState,
): void {
  if (!/\bwaitpid\s*\(/.test(line)) return;
  pushEvent(
    state,
    'wait',
    'waitpid',
    processIdentity,
    filePath,
    lineNumber,
    line,
    [],
    undefined,
    'complete',
    [],
  );
}

function extractPidfd(
  line: string,
  lineNumber: number,
  filePath: string,
  processIdentity: string,
  state: MutableState,
): void {
  const match = line.match(
    /(?:^|[=,\s])(?:(?:int|auto)\s+)?([A-Za-z_]\w*)\s*=\s*(pidfd_[A-Za-z0-9_]+)\s*\((.*)\)/,
  );
  if (!match) return;
  const localName = match[1];
  const mechanism = match[2];
  const resource = pushInstance(
    state,
    mechanism === 'pidfd_open' ? 'pidfd' : 'unknown',
    mechanism,
    processIdentity,
    filePath,
    lineNumber,
    line,
    {
      descriptor: match[3],
    },
  );
  pushHandle(
    state,
    localName,
    'pidfd',
    resource.resourceInstanceId,
    processIdentity,
    filePath,
    lineNumber,
    line,
    'unknown',
  );
  const unresolved =
    mechanism === 'pidfd_getfd' ? ['pidfd_getfd remote resource identity unresolved'] : [];
  pushEvent(
    state,
    'pidfd',
    mechanism,
    processIdentity,
    filePath,
    lineNumber,
    line,
    [handleId(processIdentity, localName)],
    resource.resourceInstanceId,
    unresolved.length > 0 ? 'unresolved' : 'complete',
    unresolved,
  );
}

function extractUnsupported(
  line: string,
  lineNumber: number,
  filePath: string,
  processIdentity: string,
  state: MutableState,
): void {
  for (const match of line.matchAll(/\b(posix_spawn|vfork|clone|sendmsg|recvmsg|SCM_RIGHTS)\b/g)) {
    const mechanism = match[1];
    pushEvent(
      state,
      'unsupported',
      mechanism,
      processIdentity,
      filePath,
      lineNumber,
      line,
      [],
      undefined,
      'unsupported',
      [`${mechanism} extraction is unsupported by the C/C++ POSIX MVP`],
    );
    state.skipReasons.push(`unsupported ${mechanism} at ${filePath}:${lineNumber}`);
  }
}

function extractWrapperHiddenOwnership(
  line: string,
  lineNumber: number,
  filePath: string,
  processIdentity: string,
  state: MutableState,
): void {
  const match = line.match(
    /(?:^|[=,\s])(?:(?:int|auto)\s+)?([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\(/,
  );
  if (!match) return;
  const callee = match[2];
  if (
    /^(open|openat|socket|pipe|pipe2|dup|dup2|dup3|fork|waitpid|fcntl|close|exec[a-z]*)$/.test(
      callee,
    )
  )
    return;
  if (!/(fd|open|socket|pipe|pidfd)/i.test(callee)) return;
  const localName = match[1];
  pushHandle(
    state,
    localName,
    'variable',
    undefined,
    processIdentity,
    filePath,
    lineNumber,
    line,
    'unknown',
    ['wrapper-hidden ownership unresolved'],
  );
  pushEvent(
    state,
    'unresolved',
    'wrapper-hidden-ownership',
    processIdentity,
    filePath,
    lineNumber,
    line,
    [handleId(processIdentity, localName)],
    undefined,
    'unresolved',
    ['wrapper-hidden ownership unresolved'],
  );
  state.skipReasons.push(`wrapper-hidden ownership at ${filePath}:${lineNumber}`);
}

function finalizePipeFindings(
  filePath: string,
  processIdentity: string,
  state: MutableState,
): void {
  for (const pipe of state.pipeGroups) {
    const closed = new Set(
      state.facts
        .filter(
          (fact): fact is ResourceEvent =>
            fact.kind === 'systems-audit-resource-event' && fact.eventKind === 'release',
        )
        .flatMap((event) => event.handleIds),
    );
    const readClosed = closed.has(handleId(processIdentity, pipe.read));
    const writeClosed = closed.has(handleId(processIdentity, pipe.write));
    if (!pipe.atomicCloexec) {
      state.findings.push({
        id: `pipe-cloexec:${filePath}:${pipe.line}:${pipe.localName}`,
        category: 'fork-safety',
        severity: 'medium',
        confidence: 0.82,
        message: `pipe ${pipe.localName} is created without atomic O_CLOEXEC`,
        status: 'open',
        evidence: [
          createSourceEvidence({ filePath, line: pipe.line, snippet: pipe.evidenceSnippet }),
        ],
      });
    }
    if (!readClosed || !writeClosed) {
      state.findings.push({
        id: `pipe-release:${filePath}:${pipe.line}:${pipe.localName}`,
        category: 'resource-leaks',
        severity: 'low',
        confidence: 0.68,
        message: `pipe ${pipe.localName} release paths are ${readClosed || writeClosed ? 'partial' : 'unresolved'}`,
        status: readClosed || writeClosed ? 'unresolved' : 'unresolved',
        evidence: [
          createSourceEvidence({ filePath, line: pipe.line, snippet: pipe.evidenceSnippet }),
        ],
      });
    }
  }
}

function pushInstance(
  state: MutableState,
  resourceKind: ResourceInstance['resourceKind'],
  mechanism: string,
  processIdentity: string,
  filePath: string,
  line: number,
  snippet: string,
  identity: ResourceInstance['identity'],
): ResourceInstance {
  const resourceInstanceId = `${processIdentity}:resource:${mechanism}:${line}:${++state.sequence}`;
  const instance: ResourceInstance = {
    kind: 'systems-audit-resource-instance',
    resourceInstanceId,
    resourceKind,
    processIdentity,
    filePath,
    lineSpan: { startLine: line, endLine: line },
    mechanism,
    identity,
    unresolved: [],
    confidence: 0.8,
    evidence: [createSourceEvidence({ filePath, line, snippet })],
  };
  state.facts.push(instance);
  return instance;
}

function pushHandle(
  state: MutableState,
  localName: string,
  handleKind: ResourceHandle['handleKind'],
  resourceInstanceId: string | undefined,
  processIdentity: string,
  filePath: string,
  line: number,
  snippet: string,
  closeOnExec: ResourceHandle['closeOnExec'],
  unresolved: string[] = [],
): ResourceHandle {
  const normalized = normalizeHandleName(localName);
  const handle: ResourceHandle = {
    kind: 'systems-audit-resource-handle',
    handleId: handleId(processIdentity, normalized),
    resourceInstanceId,
    processIdentity,
    handleKind,
    localName: normalized,
    fdNumber: numericFd(normalized),
    ownership: unresolved.length > 0 ? 'unresolved' : 'owned',
    closeOnExec,
    filePath,
    lineSpan: { startLine: line, endLine: line },
    unresolved,
    confidence: unresolved.length > 0 ? 0.45 : 0.78,
    evidence: [createSourceEvidence({ filePath, line, snippet })],
  };
  state.handlesByName.set(normalized, handle);
  state.facts.push(handle);
  return handle;
}

function pushEvent(
  state: MutableState,
  eventKind: ResourceEvent['eventKind'],
  mechanism: string,
  processIdentity: string,
  filePath: string,
  line: number,
  snippet: string,
  handleIds: string[],
  resourceInstanceId: string | undefined,
  status: ResourceEvent['status'],
  unresolved: string[],
): ResourceEvent {
  const event: ResourceEvent = {
    kind: 'systems-audit-resource-event',
    eventId: `${processIdentity}:event:${mechanism}:${line}:${++state.sequence}`,
    eventKind,
    mechanism,
    processIdentity,
    resourceInstanceId,
    handleIds,
    filePath,
    lineSpan: { startLine: line, endLine: line },
    status,
    unresolved,
    confidence: unresolved.length > 0 ? 0.45 : 0.78,
    evidence: [createSourceEvidence({ filePath, line, snippet })],
  };
  state.facts.push(event);
  return event;
}

function handleId(processIdentity: string, localName: string): string {
  return `${processIdentity}:handle:${normalizeHandleName(localName)}`;
}

function normalizeHandleName(value: string): string {
  return value.trim().replace(/\s+/g, '');
}

function numericFd(value: string): number | undefined {
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : undefined;
}

function firstStringLiteral(value: string): string | undefined {
  return value.match(/"([^"]*)"/)?.[1];
}

function stripLineComment(line: string): string {
  return line.replace(/\/\/.*$/, '');
}

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => '\n'.repeat(match.split('\n').length - 1));
}
