export type VirtualDiffHunkDecision = 'accept' | 'reject' | 'defer';

export interface VirtualDiffHunk {
  id: string;
  index: number;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface VirtualDiffFile {
  path: string;
  hunks: VirtualDiffHunk[];
}

export interface VirtualDiffDiagnostic {
  code: string;
  message: string;
  hunkId?: string;
  filePath?: string;
}

export interface VirtualDiff {
  files: VirtualDiffFile[];
  diagnostics: VirtualDiffDiagnostic[];
}

interface InputVirtualDiffHunk {
  id?: string;
  index?: number;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

interface InputVirtualDiffFile {
  path: string;
  hunks: readonly InputVirtualDiffHunk[];
}

export interface VirtualDiffInput {
  files: readonly InputVirtualDiffFile[];
  diagnostics?: readonly VirtualDiffDiagnostic[];
}

export interface VirtualDiffSelectionDiagnostic {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  hunkId?: string;
}

export interface VirtualDiffDecisionInput {
  hunkId: string;
  decision: VirtualDiffHunkDecision;
  stagedContextEntryIds?: readonly string[];
  diagnostics?: readonly VirtualDiffSelectionDiagnostic[];
}

export interface VirtualDiffSelection {
  hunkId: string;
  status: VirtualDiffHunkDecision;
  filePath: string;
  hunk: VirtualDiffHunk;
  stagedContextEntryIds: string[];
  diagnostics: VirtualDiffSelectionDiagnostic[];
  decisionProvided: boolean;
}

export interface VirtualDiffSelectionPlan {
  virtualDiff: VirtualDiff;
  selections: VirtualDiffSelection[];
  acceptedHunkCount: number;
  rejectedHunkCount: number;
  deferredHunkCount: number;
  affectedFiles: number;
  diagnostics: VirtualDiffSelectionDiagnostic[];
  warnings: VirtualDiffSelectionDiagnostic[];
}

const HUNK_HEADER_RE = /^@@\s+-([0-9]+)(?:,([0-9]+))?\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/;

const normalizePath = (rawPath: string): string | null => {
  const trimmed = rawPath.trim().replace(/^\"|\"$/g, '');

  if (!trimmed || trimmed === '/dev/null') {
    return null;
  }

  if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) {
    return trimmed.slice(2);
  }

  return trimmed;
};

const parseCount = (value: string | undefined): number => {
  if (!value || Number.isNaN(Number.parseInt(value, 10))) {
    return 1;
  }

  return Number.parseInt(value, 10);
};

const makeHunkId = (
  filePath: string,
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
  index: number,
): string =>
  `${filePath}@@${oldStart},${oldCount}+${newStart},${newCount}#${index}`;

const isVirtualDiff = (input: string | VirtualDiffInput): input is VirtualDiffInput => {
  return typeof input !== 'string';
};

const normalizeVirtualDiffObject = (input: VirtualDiffInput): VirtualDiff => {
  const files: VirtualDiffFile[] = [];
  const seenFiles = new Map<string, number>();
  const diagnostics: VirtualDiffDiagnostic[] = (input.diagnostics ?? []).map((diagnostic) => ({
    ...diagnostic,
  }));

  for (const file of input.files) {
    const normalizedPath = normalizePath(file.path);
    if (normalizedPath === null) {
      diagnostics.push({
        code: 'virtual-diff-invalid-file-path',
        message: `Skipping virtual diff file with invalid path: ${file.path}`,
        filePath: file.path,
      });
      continue;
    }

    const existingIndex = seenFiles.get(normalizedPath);
    const targetFile =
      existingIndex === undefined
        ? (() => {
            const fileIndex = files.length;
            const entry: VirtualDiffFile = { path: normalizedPath, hunks: [] };
            files.push(entry);
            seenFiles.set(normalizedPath, fileIndex);
            return entry;
          })()
        : files[existingIndex];

    for (const hunk of file.hunks) {
      const oldStart = Number.isFinite(Number(hunk.oldStart))
        ? Math.trunc(hunk.oldStart)
        : 0;
      const oldCount = Number.isFinite(Number(hunk.oldCount))
        ? Math.trunc(hunk.oldCount)
        : 1;
      const newStart = Number.isFinite(Number(hunk.newStart))
        ? Math.trunc(hunk.newStart)
        : 0;
      const newCount = Number.isFinite(Number(hunk.newCount))
        ? Math.trunc(hunk.newCount)
        : 1;
      const hunkIndex = targetFile.hunks.length;
      targetFile.hunks.push({
        index: hunkIndex,
        oldStart,
        oldCount,
        newStart,
        newCount,
        id: hunk.id ?? makeHunkId(normalizedPath, oldStart, oldCount, newStart, newCount, hunkIndex),
      });
    }
  }

  return {
    files,
    diagnostics,
  };
};

export const parseVirtualDiff = (diffText: string): VirtualDiff => {
  const files: VirtualDiffFile[] = [];
  const seenFiles = new Map<string, number>();
  const warnings: VirtualDiffDiagnostic[] = [];

  let currentPath: string | null = null;

  const getCurrentFile = (): VirtualDiffFile | null => {
    if (currentPath === null) {
      return null;
    }

    const index = seenFiles.get(currentPath);
    if (index === undefined) {
      const file: VirtualDiffFile = { path: currentPath, hunks: [] };
      files.push(file);
      seenFiles.set(currentPath, files.length - 1);
      return file;
    }

    return files[index];
  };

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const tokens = line.slice('diff --git '.length).trim().split(/\s+/);
      const candidate = tokens.length > 1 ? normalizePath(tokens[1]) : null;
      currentPath = candidate;
      continue;
    }

    if (line.startsWith('+++')) {
      const candidate = normalizePath(line.slice(3).trim());
      if (candidate) {
        currentPath = candidate;
        if (!seenFiles.has(currentPath)) {
          files.push({ path: currentPath, hunks: [] });
          seenFiles.set(currentPath, files.length - 1);
        }
      }
      continue;
    }

    const match = line.match(HUNK_HEADER_RE);
    if (!match || currentPath === null) {
      continue;
    }

    const oldStart = Number.parseInt(match[1], 10);
    const oldCount = parseCount(match[2]);
    const newStart = Number.parseInt(match[3], 10);
    const newCount = parseCount(match[4]);

    if (
      Number.isNaN(oldStart) ||
      Number.isNaN(oldCount) ||
      Number.isNaN(newStart) ||
      Number.isNaN(newCount)
    ) {
      warnings.push({
        code: 'virtual-diff-invalid-hunk-header',
        message: `Unable to parse unified hunk header: ${line}`,
      });
      continue;
    }

    const file = getCurrentFile();
    if (!file) {
      continue;
    }

    const index = file.hunks.length;
    file.hunks.push({
      id: makeHunkId(currentPath, oldStart, oldCount, newStart, newCount, index),
      index,
      oldStart,
      oldCount,
      newStart,
      newCount,
    });
  }

  return {
    files: files.filter((file) => file.hunks.length > 0),
    diagnostics: warnings,
  };
};

export const normalizeVirtualDiff = (input: string | VirtualDiffInput): VirtualDiff => {
  return isVirtualDiff(input)
    ? normalizeVirtualDiffObject(input as VirtualDiffInput)
    : parseVirtualDiff(input as string);
};

export const buildVirtualDiffSelectionPlan = (
  diff: string | VirtualDiffInput,
  decisions: readonly VirtualDiffDecisionInput[] = [],
): VirtualDiffSelectionPlan => {
  const virtualDiff = normalizeVirtualDiff(diff);

  const hunkById = new Map<string, { filePath: string; hunk: VirtualDiffHunk }>();

  for (const file of virtualDiff.files) {
    for (const hunk of file.hunks) {
      hunkById.set(hunk.id, { filePath: file.path, hunk });
    }
  }

  const decisionByHunkId = new Map<string, VirtualDiffDecisionInput>();
  const diagnostics: VirtualDiffSelectionDiagnostic[] = virtualDiff.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    severity: 'warning',
  }));

  for (const decision of decisions) {
    if (!hunkById.has(decision.hunkId)) {
      diagnostics.push({
        code: 'virtual-diff-unknown-hunk-id',
        message: `Unknown hunk id: ${decision.hunkId}`,
        severity: 'warning',
        hunkId: decision.hunkId,
      });
      continue;
    }

    if (decisionByHunkId.has(decision.hunkId)) {
      diagnostics.push({
        code: 'virtual-diff-duplicate-decision',
        message: `Duplicate decision for hunk id: ${decision.hunkId}`,
        severity: 'warning',
        hunkId: decision.hunkId,
      });
      continue;
    }

    decisionByHunkId.set(decision.hunkId, {
      hunkId: decision.hunkId,
      decision: decision.decision,
      stagedContextEntryIds: decision.stagedContextEntryIds
        ? [...decision.stagedContextEntryIds]
        : undefined,
      diagnostics: decision.diagnostics ? [...decision.diagnostics] : undefined,
    });
  }

  const selections: VirtualDiffSelection[] = [];
  let acceptedHunkCount = 0;
  let rejectedHunkCount = 0;
  let deferredHunkCount = 0;
  let affectedFiles = 0;

  for (const file of virtualDiff.files) {
    for (const hunk of file.hunks) {
      const decision = decisionByHunkId.get(hunk.id);
      const status = decision?.decision ?? 'defer';
      if (status === 'accept') {
        acceptedHunkCount += 1;
      } else if (status === 'reject') {
        rejectedHunkCount += 1;
      } else {
        deferredHunkCount += 1;
      }

      const inputDiagnostics: VirtualDiffSelectionDiagnostic[] =
        decision?.diagnostics?.map((entry) => ({ ...entry, hunkId: decision.hunkId })) ?? [];
      selections.push({
        hunkId: hunk.id,
        status,
        filePath: file.path,
        hunk,
        stagedContextEntryIds: decision?.stagedContextEntryIds
          ? [...new Set(decision.stagedContextEntryIds)]
          : [],
        diagnostics: inputDiagnostics,
        decisionProvided: Boolean(decision),
      });
    }

    if (file.hunks.length > 0) {
      affectedFiles += 1;
    }
  }

  return {
    virtualDiff,
    selections,
    acceptedHunkCount,
    rejectedHunkCount,
    deferredHunkCount,
    affectedFiles,
    diagnostics,
    warnings: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning'),
  };
};
