import { createHash } from 'node:crypto';

import type { AuditFingerprint } from './audit-types.js';

export interface FindingFingerprintInput {
  title: string;
  claim: string;
  path?: string;
  line?: number;
  symbol?: string;
  targetHead: string;
  sourceHash?: string;
}

export interface LayeredFindingFingerprint {
  fingerprint: AuditFingerprint;
  exactKey: string;
  stableId: string;
}

export function createFindingFingerprint(
  input: FindingFingerprintInput,
): LayeredFindingFingerprint {
  const normalizedPath = normalizeToken(input.path);
  const normalizedSymbol = normalizeToken(input.symbol);
  const normalizedClaim = normalizeText(input.claim || input.title);
  const normalizedTitle = normalizeText(input.title);
  const locationParts = [
    normalizedPath || 'unknown-path',
    input.line !== undefined ? String(input.line) : 'unknown-line',
    normalizedSymbol || 'unknown-symbol',
  ];
  const claimParts = [normalizedTitle, normalizedClaim];
  const historyParts = [input.targetHead, input.sourceHash ?? 'unknown-source'];
  const location = sha256(locationParts.join('\n'));
  const claim = sha256(claimParts.join('\n'));
  const history = sha256(historyParts.join('\n'));
  const exactKey = sha256([location, claim].join('\n'));

  return {
    fingerprint: {
      location: `sha256:${location}`,
      claim: `sha256:${claim}`,
      history: `sha256:${history}`,
    },
    exactKey: `sha256:${exactKey}`,
    stableId: `AUDIT-${sha256([input.targetHead, exactKey].join('\n')).slice(0, 12).toUpperCase()}`,
  };
}

export function hashAuditSource(text: string): string {
  return `sha256:${sha256(text)}`;
}

export function normalizeFindingText(text: string): string {
  return normalizeText(text);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/`+/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeToken(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\\/g, '/').toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
