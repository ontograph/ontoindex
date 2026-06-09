import { createHash } from 'node:crypto';

import type { Definition, Heading as MdastHeading, PhrasingContent, Root } from 'mdast';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import { frontmatter } from 'micromark-extension-frontmatter';

import {
  CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION,
  createMarkdownChunkKey,
  type MarkdownAcceptanceCriterionFact,
  type MarkdownApiSpecFact,
  type MarkdownChunkFact,
  type MarkdownCodeMentionCandidate,
  type MarkdownCodeMentionFact,
  type MarkdownCodeMentionResolutionReason,
  type MarkdownCodeMentionResolutionStatus,
  type MarkdownCodeMentionTarget,
  type MarkdownDocOwnerFact,
  type MarkdownDocumentFact,
  type MarkdownEntityFact,
  type MarkdownFrontmatterMetadata,
  type MarkdownHttpMethod,
  type MarkdownLineSpan,
  type MarkdownLinkFact,
  type MarkdownRequirementFact,
  type MarkdownTestMentionFact,
  normalizeMarkdownAnchor,
} from './markdown-document-facts.js';

export interface MarkdownSidecarProducerOptions {
  excerptMaxBytes?: number;
  excerptMaxLines?: number;
  resolveCodeMention?: MarkdownCodeMentionResolver;
}

export interface ProduceMarkdownSidecarFactsInput {
  docPath: string;
  source: string;
  sourceCommitHash: string;
  options?: MarkdownSidecarProducerOptions;
}

export interface MarkdownCodeMentionResolution {
  target?: MarkdownCodeMentionTarget;
  confidence?: number;
  resolutionStatus: MarkdownCodeMentionResolutionStatus;
  resolutionReason?: MarkdownCodeMentionResolutionReason;
  candidates?: MarkdownCodeMentionCandidate[];
}

export type MarkdownCodeMentionResolver = (
  mention: string,
  evidence: { lineSpan: MarkdownLineSpan; chunkKey: string },
) => MarkdownCodeMentionResolution | undefined;

interface ParsedLine {
  number: number;
  text: string;
}

interface Heading {
  level: number;
  title: string;
  line: number;
  path: string[];
  anchor: string;
}

interface Section {
  heading?: Heading;
  lineSpan: MarkdownLineSpan;
  lines: ParsedLine[];
}

interface LinkReference {
  href: string;
  line: number;
}

interface ParsedFrontmatter {
  metadata: MarkdownFrontmatterMetadata;
  ownerLine?: ParsedLine;
}

const DEFAULT_EXCERPT_MAX_BYTES = 2048;
const DEFAULT_EXCERPT_MAX_LINES = 40;
const REQUIREMENT_ID_PATTERN = /\bREQ-[A-Za-z0-9][A-Za-z0-9._-]*\b/g;
const API_SPEC_PATTERN =
  /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+`?(\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%{}-]*)`?/g;
const TEST_PATH_PATTERN = /(?:\.{0,2}\/)?[A-Za-z0-9_.\-/]*(?:\.test|\.spec)\.[tj]sx?\b/g;
const ACCEPTANCE_HEADINGS = new Set(['acceptance', 'acceptance-criteria', 'requirements']);
const MARKDOWN_HTTP_METHODS = new Set<string>([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
]);

export function produceMarkdownSidecarFacts(
  input: ProduceMarkdownSidecarFactsInput,
): MarkdownDocumentFact[] {
  const lines = splitLines(input.source);
  const ast = parseMarkdownAst(input.source);
  const fileHash = hashText(input.source);
  const referenceLinks = collectReferenceLinks(ast);
  const sections = parseSections(lines, ast);
  const frontmatter = parseFrontmatterMetadata(lines);
  const facts: MarkdownDocumentFact[] = [];

  sections.forEach((section, chunkIndex) => {
    const text = section.lines.map((line) => line.text).join('\n');
    const contentHash = hashText(text);
    const headingPath = section.heading?.path ?? [];
    const normalizedAnchor = section.heading?.anchor ?? '';
    const chunkKey = createMarkdownChunkKey({
      docPath: input.docPath,
      fileHash,
      headingPath,
      normalizedAnchor,
      contentHash,
    });
    const chunk: MarkdownChunkFact = {
      kind: 'markdown-chunk',
      docPath: input.docPath,
      fileHash,
      sourceCommitHash: input.sourceCommitHash,
      headingPath,
      lineSpan: section.lineSpan,
      chunkIndex,
      normalizedAnchor,
      contentHash,
      chunkKey,
      excerpt: capExcerpt(text, {
        maxBytes: input.options?.excerptMaxBytes ?? DEFAULT_EXCERPT_MAX_BYTES,
        maxLines: input.options?.excerptMaxLines ?? DEFAULT_EXCERPT_MAX_LINES,
      }),
    };
    facts.push(chunk);
    facts.push(...extractLinks(section, chunkKey, referenceLinks));
    facts.push(...extractEntities(input.docPath, section, chunkKey));
    facts.push(...extractCodeMentions(section, chunkKey, input.options?.resolveCodeMention));
    facts.push(...extractTypedFacts(input.docPath, section, chunkKey, frontmatter));
  });

  return facts;
}

export function capExcerpt(text: string, caps: { maxBytes: number; maxLines: number }): string {
  const selectedLines = text.split('\n').slice(0, Math.max(0, caps.maxLines));
  let excerpt = selectedLines.join('\n');
  const bytes = Buffer.from(excerpt, 'utf8');
  if (bytes.length <= caps.maxBytes) {
    return excerpt;
  }
  excerpt = bytes.subarray(0, Math.max(0, caps.maxBytes)).toString('utf8');
  return excerpt.replace(/\uFFFD$/u, '');
}

export function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function extractTypedFacts(
  docPath: string,
  section: Section,
  sourceChunkKey: string,
  frontmatter: ParsedFrontmatter,
): MarkdownDocumentFact[] {
  return [
    ...extractDocOwnerFact(docPath, section, sourceChunkKey, frontmatter),
    ...extractRequirementFacts(docPath, section, sourceChunkKey, frontmatter.metadata),
    ...extractAcceptanceCriteriaFacts(docPath, section, sourceChunkKey, frontmatter.metadata),
    ...extractApiSpecFacts(docPath, section, sourceChunkKey, frontmatter.metadata),
    ...extractTestMentionFacts(docPath, section, sourceChunkKey, frontmatter.metadata),
  ];
}

function parseFrontmatterMetadata(lines: ParsedLine[]): ParsedFrontmatter {
  const metadata: MarkdownFrontmatterMetadata = {};
  if (lines[0]?.text.trim() !== '---') {
    return { metadata };
  }

  let currentScope: string | undefined;
  let ownerLine: ParsedLine | undefined;
  for (const line of lines.slice(1)) {
    if (line.text.trim() === '---') {
      break;
    }
    const match = /^(?<indent>\s*)(?<key>[A-Za-z0-9_.-]+):\s*(?<value>.*)$/.exec(line.text);
    if (!match?.groups) {
      continue;
    }
    const indent = match.groups.indent.length;
    const key = match.groups.key;
    const value = parseFrontmatterScalar(match.groups.value);
    if (indent === 0) {
      currentScope = value === undefined ? key : undefined;
    }
    const scopedKey = indent > 0 && currentScope ? `${currentScope}.${key}` : key;
    if (value === undefined) {
      continue;
    }
    if (scopedKey === 'ontoindex.kind') {
      metadata.ontoindexKind = value;
    } else if (scopedKey === 'service' || scopedKey === 'ontoindex.service') {
      metadata.service = value;
    } else if (scopedKey === 'owner' || scopedKey === 'ontoindex.owner') {
      metadata.owner = value;
      ownerLine = line;
    } else if (scopedKey === 'status' || scopedKey === 'ontoindex.status') {
      metadata.status = value;
    }
  }

  return ownerLine ? { metadata, ownerLine } : { metadata };
}

function parseFrontmatterScalar(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.replace(/^['"]|['"]$/g, '');
}

function extractDocOwnerFact(
  docPath: string,
  section: Section,
  sourceChunkKey: string,
  frontmatter: ParsedFrontmatter,
): MarkdownDocOwnerFact[] {
  if (
    frontmatter.metadata.owner === undefined ||
    frontmatter.ownerLine === undefined ||
    !sectionContainsLine(section, frontmatter.ownerLine.number)
  ) {
    return [];
  }

  const lineSpan = { start: frontmatter.ownerLine.number, end: frontmatter.ownerLine.number };
  const fact: MarkdownDocOwnerFact = {
    kind: 'markdown-doc-owner',
    schemaVersion: CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION,
    docPath,
    headingPath: section.heading?.path ?? [],
    lineSpan,
    sourceChunkKey,
    normalizedKey: [
      'markdown-doc-owner',
      docPath,
      normalizeMarkdownAnchor(frontmatter.metadata.owner),
    ].join(':'),
    confidence: 1,
    owner: frontmatter.metadata.owner,
    evidence: { text: frontmatter.metadata.owner, raw: frontmatter.ownerLine.text, lineSpan },
    ...metadataFields(frontmatter.metadata),
  };
  if (frontmatter.metadata.service !== undefined) {
    fact.service = frontmatter.metadata.service;
  }
  if (frontmatter.metadata.status !== undefined) {
    fact.status = frontmatter.metadata.status;
  }
  if (frontmatter.metadata.ontoindexKind !== undefined) {
    fact.ontoindexKind = frontmatter.metadata.ontoindexKind;
  }
  return [fact];
}

function extractRequirementFacts(
  docPath: string,
  section: Section,
  sourceChunkKey: string,
  metadata: MarkdownFrontmatterMetadata,
): MarkdownRequirementFact[] {
  const facts: MarkdownRequirementFact[] = [];
  if (section.heading) {
    for (const requirementId of matchRequirementIds(section.heading.title)) {
      const lineSpan = { start: section.heading.line, end: section.heading.line };
      facts.push({
        kind: 'markdown-requirement',
        schemaVersion: CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION,
        docPath,
        headingPath: section.heading.path,
        lineSpan,
        sourceChunkKey,
        normalizedKey: normalizedTypedKey('markdown-requirement', docPath, requirementId),
        confidence: 0.95,
        requirementId,
        title: section.heading.title,
        source: 'heading',
        evidence: { text: requirementId, raw: section.heading.title, lineSpan },
        ...metadataFields(metadata),
      });
    }
  }

  for (const line of section.lines) {
    if (line.number === section.heading?.line) {
      continue;
    }
    for (const requirementId of matchRequirementIds(line.text)) {
      const lineSpan = { start: line.number, end: line.number };
      facts.push({
        kind: 'markdown-requirement',
        schemaVersion: CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION,
        docPath,
        headingPath: section.heading?.path ?? [],
        lineSpan,
        sourceChunkKey,
        normalizedKey: normalizedTypedKey('markdown-requirement', docPath, requirementId),
        confidence: 0.85,
        requirementId,
        source: 'body',
        evidence: { text: requirementId, raw: line.text, lineSpan },
        ...metadataFields(metadata),
      });
    }
  }
  return facts;
}

function extractAcceptanceCriteriaFacts(
  docPath: string,
  section: Section,
  sourceChunkKey: string,
  metadata: MarkdownFrontmatterMetadata,
): MarkdownAcceptanceCriterionFact[] {
  const headingAnchor = section.heading?.anchor ?? '';
  if (!ACCEPTANCE_HEADINGS.has(headingAnchor)) {
    return [];
  }

  const facts: MarkdownAcceptanceCriterionFact[] = [];
  for (const line of section.lines) {
    const bullet = /^\s*[-*+]\s+(?<text>.+)$/.exec(line.text);
    if (!bullet?.groups) {
      continue;
    }
    const criterion = bullet.groups.text.trim();
    const lineSpan = { start: line.number, end: line.number };
    const requirementId =
      matchRequirementIds(criterion)[0] ?? nearestRequirementId(section, line.number);
    facts.push({
      kind: 'markdown-acceptance-criterion',
      schemaVersion: CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION,
      docPath,
      headingPath: section.heading?.path ?? [],
      lineSpan,
      sourceChunkKey,
      normalizedKey: normalizedTypedKey(
        'markdown-acceptance-criterion',
        docPath,
        `${section.heading?.anchor ?? 'root'}:${facts.length + 1}:${criterion}`,
      ),
      confidence: 0.9,
      criterion,
      ordinal: facts.length + 1,
      evidence: { text: criterion, raw: line.text, lineSpan },
      ...metadataFields(metadata),
    });
    if (requirementId !== undefined) {
      facts[facts.length - 1].requirementId = requirementId;
    }
  }
  return facts;
}

function extractApiSpecFacts(
  docPath: string,
  section: Section,
  sourceChunkKey: string,
  metadata: MarkdownFrontmatterMetadata,
): MarkdownApiSpecFact[] {
  const facts: MarkdownApiSpecFact[] = [];
  for (const line of section.lines) {
    for (const match of line.text.matchAll(API_SPEC_PATTERN)) {
      const method = match[1] as MarkdownHttpMethod;
      const path = stripTrailingRoutePunctuation(match[2]);
      facts.push(createApiSpecFact(docPath, section, sourceChunkKey, metadata, line, method, path));
    }
    const tableSpec = apiSpecFromSimpleTableRow(line.text);
    if (tableSpec !== undefined) {
      facts.push(
        createApiSpecFact(
          docPath,
          section,
          sourceChunkKey,
          metadata,
          line,
          tableSpec.method,
          tableSpec.path,
        ),
      );
    }
  }
  return facts;
}

function createApiSpecFact(
  docPath: string,
  section: Section,
  sourceChunkKey: string,
  metadata: MarkdownFrontmatterMetadata,
  line: ParsedLine,
  method: MarkdownHttpMethod,
  path: string,
): MarkdownApiSpecFact {
  const lineSpan = { start: line.number, end: line.number };
  return {
    kind: 'markdown-api-spec',
    schemaVersion: CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION,
    docPath,
    headingPath: section.heading?.path ?? [],
    lineSpan,
    sourceChunkKey,
    normalizedKey: normalizedTypedKey('markdown-api-spec', docPath, `${method}:${path}`),
    confidence: 0.9,
    method,
    path,
    routeKey: `${method} ${path}`,
    evidence: { text: `${method} ${path}`, raw: line.text, lineSpan },
    ...metadataFields(metadata),
  };
}

function apiSpecFromSimpleTableRow(
  line: string,
): { method: MarkdownHttpMethod; path: string } | undefined {
  if (!line.includes('|') || /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) {
    return undefined;
  }
  const cells = line
    .split('|')
    .map((cell) => cell.trim().replace(/^`|`$/g, ''))
    .filter((cell) => cell.length > 0);
  for (let index = 0; index < cells.length - 1; index += 1) {
    const method = cells[index];
    const path = cells[index + 1];
    if (
      method !== undefined &&
      path !== undefined &&
      isMarkdownHttpMethod(method) &&
      path.startsWith('/')
    ) {
      return {
        method,
        path: stripTrailingRoutePunctuation(path),
      };
    }
  }
  return undefined;
}

function isMarkdownHttpMethod(value: string): value is MarkdownHttpMethod {
  return MARKDOWN_HTTP_METHODS.has(value);
}

function extractTestMentionFacts(
  docPath: string,
  section: Section,
  sourceChunkKey: string,
  metadata: MarkdownFrontmatterMetadata,
): MarkdownTestMentionFact[] {
  const facts: MarkdownTestMentionFact[] = [];
  const seen = new Set<string>();
  for (const line of section.lines) {
    for (const match of line.text.matchAll(TEST_PATH_PATTERN)) {
      const mention = match[0];
      const lineSpan = { start: line.number, end: line.number };
      const containment = normalizeContainedPath(docPath, mention);
      const key = `${line.number}:${mention}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      facts.push({
        kind: 'markdown-test-mention',
        schemaVersion: CURRENT_MARKDOWN_DOCUMENT_FACT_SCHEMA_VERSION,
        docPath,
        headingPath: section.heading?.path ?? [],
        lineSpan,
        sourceChunkKey,
        normalizedKey: normalizedTypedKey('markdown-test-mention', docPath, mention),
        confidence: 0.85,
        mention,
        resolvable: containment.resolvable,
        evidence: { text: mention, raw: line.text, lineSpan },
        ...metadataFields(metadata),
      });
      if (containment.path !== undefined) {
        facts[facts.length - 1].targetPath = containment.path;
      }
      if (containment.unsafeReason !== undefined) {
        facts[facts.length - 1].unsafeReason = containment.unsafeReason;
      }
    }
  }
  return facts;
}

function matchRequirementIds(text: string): string[] {
  return [...text.matchAll(REQUIREMENT_ID_PATTERN)].map((match) => match[0]);
}

function nearestRequirementId(section: Section, beforeLine: number): string | undefined {
  const headingRequirement = section.heading
    ? matchRequirementIds(section.heading.title)[0]
    : undefined;
  if (headingRequirement !== undefined) {
    return headingRequirement;
  }
  for (const line of section.lines) {
    if (line.number >= beforeLine) {
      break;
    }
    const requirementId = matchRequirementIds(line.text)[0];
    if (requirementId !== undefined) {
      return requirementId;
    }
  }
  return undefined;
}

function stripTrailingRoutePunctuation(routePath: string): string {
  return routePath.replace(/[),.;:]+$/u, '');
}

function normalizeContainedPath(
  docPath: string,
  mention: string,
): { path?: string; resolvable: boolean; unsafeReason?: 'absolute-path' | 'path-outside-repo' } {
  const withoutAnchor = mention.split('#')[0];
  if (withoutAnchor.startsWith('/')) {
    return { path: withoutAnchor, resolvable: false, unsafeReason: 'absolute-path' };
  }

  const docDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '.';
  const normalizedPath =
    withoutAnchor.startsWith('./') || withoutAnchor.startsWith('../')
      ? normalizePosixPath(`${docDir}/${withoutAnchor}`)
      : normalizePosixPath(withoutAnchor);
  if (normalizedPath.startsWith('../') || normalizedPath === '..') {
    return { path: normalizedPath, resolvable: false, unsafeReason: 'path-outside-repo' };
  }
  return { path: normalizedPath, resolvable: true };
}

function normalizePosixPath(value: string): string {
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop();
      } else {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function sectionContainsLine(section: Section, lineNumber: number): boolean {
  return lineNumber >= section.lineSpan.start && lineNumber <= section.lineSpan.end;
}

function normalizedTypedKey(kind: string, docPath: string, value: string): string {
  return [kind, docPath, normalizeMarkdownAnchor(value)].join(':');
}

function metadataOrUndefined(
  metadata: MarkdownFrontmatterMetadata,
): MarkdownFrontmatterMetadata | undefined {
  return Object.values(metadata).some((value) => value !== undefined) ? metadata : undefined;
}

function metadataFields(metadata: MarkdownFrontmatterMetadata): {
  metadata?: MarkdownFrontmatterMetadata;
} {
  const normalized = metadataOrUndefined(metadata);
  return normalized === undefined ? {} : { metadata: normalized };
}

function splitLines(source: string): ParsedLine[] {
  const normalized = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawLines = normalized.split('\n');
  if (rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }
  return rawLines.map((text, index) => ({ number: index + 1, text }));
}

function parseMarkdownAst(source: string): Root {
  return fromMarkdown(source, {
    extensions: [gfm(), frontmatter(['yaml'])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml'])],
  });
}

function parseSections(lines: ParsedLine[], ast: Root): Section[] {
  const headingCounts = new Map<string, number>();
  const headingStack: Heading[] = [];
  const sections: Section[] = [];
  let sectionStart = 1;
  let currentHeading: Heading | undefined;

  for (const node of ast.children) {
    if (node.type !== 'heading' || node.position?.start.line === undefined) continue;
    const heading = headingFromNode(node, headingStack, headingCounts);
    if (currentHeading || heading.line > 1) {
      sections.push(makeSection(lines, sectionStart, heading.line - 1, currentHeading));
    }
    currentHeading = heading;
    sectionStart = heading.line;
  }

  if (lines.length > 0) {
    sections.push(makeSection(lines, sectionStart, lines.length, currentHeading));
  }

  return sections.filter((section) => section.lines.some((line) => line.text.trim().length > 0));
}

function makeSection(
  allLines: ParsedLine[],
  start: number,
  end: number,
  heading?: Heading,
): Section {
  return {
    heading,
    lineSpan: { start, end },
    lines: allLines.filter((line) => line.number >= start && line.number <= end),
  };
}

function headingFromNode(
  node: MdastHeading,
  headingStack: Heading[],
  headingCounts: Map<string, number>,
): Heading {
  const level = node.depth;
  const title = phrasingText(node.children).trim();
  while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
    headingStack.pop();
  }
  const baseAnchor = normalizeMarkdownAnchor(title);
  const count = headingCounts.get(baseAnchor) ?? 0;
  headingCounts.set(baseAnchor, count + 1);
  const anchor = count === 0 ? baseAnchor : `${baseAnchor}-${count}`;
  const heading: Heading = {
    level,
    title,
    line: node.position?.start.line ?? 1,
    path: [...headingStack.map((item) => item.title), title],
    anchor,
  };
  headingStack.push(heading);
  return heading;
}

function phrasingText(children: readonly PhrasingContent[]): string {
  return children
    .map((child) => {
      if ('value' in child && typeof child.value === 'string') return child.value;
      if ('children' in child && Array.isArray(child.children)) {
        return phrasingText(child.children as PhrasingContent[]);
      }
      return '';
    })
    .join('');
}

function collectReferenceLinks(ast: Root): Map<string, LinkReference> {
  const references = new Map<string, LinkReference>();
  for (const node of ast.children) {
    if (node.type !== 'definition') continue;
    const definition = node as Definition;
    references.set(definition.identifier.trim().toLowerCase(), {
      href: definition.url,
      line: definition.position?.start.line ?? 1,
    });
  }
  return references;
}

function extractLinks(
  section: Section,
  chunkKey: string,
  references: Map<string, LinkReference>,
): MarkdownLinkFact[] {
  const links: MarkdownLinkFact[] = [];
  for (const line of section.lines) {
    for (const match of line.text.matchAll(/\[([^\]]+)]\(([^)]+)\)/g)) {
      links.push(createLinkFact(chunkKey, match[2], match[1], line.number));
    }
    for (const match of line.text.matchAll(/\[([^\]]+)]\[([^\]]+)]/g)) {
      const reference = references.get(match[2].trim().toLowerCase());
      if (reference) {
        links.push(createLinkFact(chunkKey, reference.href, match[1], line.number));
      }
    }
  }
  return links;
}

function createLinkFact(
  fromChunkKey: string,
  href: string,
  text: string,
  line: number,
): MarkdownLinkFact {
  const fact: MarkdownLinkFact = {
    kind: 'markdown-link',
    fromChunkKey,
    href,
    text,
    lineSpan: { start: line, end: line },
  };
  const [pathPart, anchorPart] = href.split('#');
  if (pathPart?.endsWith('.md')) {
    fact.toDocPath = pathPart;
  }
  if (anchorPart) {
    fact.toHeadingPath = [anchorPart];
  }
  return fact;
}

function extractEntities(
  docPath: string,
  section: Section,
  chunkKey: string,
): MarkdownEntityFact[] {
  const entities: MarkdownEntityFact[] = [];
  if (section.heading) {
    const normalizedLabel = normalizeMarkdownAnchor(section.heading.title);
    entities.push({
      kind: 'markdown-entity',
      entityKey: ['markdown-entity', docPath, normalizedLabel, section.heading.anchor].join(':'),
      label: section.heading.title,
      normalizedLabel,
      entityType: inferEntityType(section.heading.title),
      sourceChunkKey: chunkKey,
      evidence: {
        text: section.heading.title,
        lineSpan: { start: section.heading.line, end: section.heading.line },
      },
    });
  }
  for (const line of section.lines) {
    const frontmatterTags = /^\s*tags:\s*\[([^\]]*)]/.exec(line.text);
    if (frontmatterTags) {
      for (const label of frontmatterTags[1].split(',').map((value) => value.trim())) {
        if (label.length === 0) {
          continue;
        }
        const normalizedLabel = normalizeMarkdownAnchor(label);
        entities.push({
          kind: 'markdown-entity',
          entityKey: ['markdown-entity', docPath, 'tag', normalizedLabel].join(':'),
          label,
          normalizedLabel,
          entityType: 'tag',
          sourceChunkKey: chunkKey,
          evidence: { text: label, lineSpan: { start: line.number, end: line.number } },
        });
      }
    }
    for (const match of line.text.matchAll(/#([A-Za-z][A-Za-z0-9_-]*)/g)) {
      const label = match[1];
      const normalizedLabel = normalizeMarkdownAnchor(label);
      entities.push({
        kind: 'markdown-entity',
        entityKey: ['markdown-entity', docPath, 'tag', normalizedLabel].join(':'),
        label,
        normalizedLabel,
        entityType: 'tag',
        sourceChunkKey: chunkKey,
        evidence: { text: match[0], lineSpan: { start: line.number, end: line.number } },
      });
    }
  }
  return entities;
}

function inferEntityType(label: string): MarkdownEntityFact['entityType'] {
  const normalized = label.toLowerCase();
  if (normalized.startsWith('adr')) {
    return 'adr';
  }
  if (normalized.includes('service')) {
    return 'service';
  }
  if (normalized.includes('module')) {
    return 'module';
  }
  return 'concept';
}

function extractCodeMentions(
  section: Section,
  chunkKey: string,
  resolver: MarkdownCodeMentionResolver | undefined,
): MarkdownCodeMentionFact[] {
  const facts: MarkdownCodeMentionFact[] = [];
  for (const line of section.lines) {
    for (const match of line.text.matchAll(/`([^`]+)`/g)) {
      const mention = match[1].trim();
      if (mention.length === 0) {
        continue;
      }
      const lineSpan = { start: line.number, end: line.number };
      const resolution = resolver?.(mention, { lineSpan, chunkKey });
      facts.push(
        createCodeMentionFact(chunkKey, mention, lineSpan, resolution, resolver !== undefined),
      );
    }
  }
  return facts;
}

function createCodeMentionFact(
  chunkKey: string,
  mention: string,
  lineSpan: MarkdownLineSpan,
  resolution: MarkdownCodeMentionResolution | undefined,
  resolverConfigured: boolean,
): MarkdownCodeMentionFact {
  const status = resolution?.resolutionStatus ?? 'unresolved';
  const target =
    status === 'resolved' || status === 'stale'
      ? (resolution?.target ?? { type: 'symbol' })
      : { type: 'symbol' as const };
  const fact: MarkdownCodeMentionFact = {
    kind: 'markdown-code-mention',
    chunkKey,
    target: stripCandidateConfidence(target),
    confidence: resolution?.confidence ?? (status === 'unresolved' ? 0 : 1),
    resolutionStatus: status,
    evidence: { text: mention, lineSpan },
  };
  const resolutionReason =
    resolution?.resolutionReason ??
    (status === 'unresolved'
      ? resolverConfigured
        ? 'resolver-returned-no-match'
        : 'no-resolver-configured'
      : undefined);
  if (resolutionReason !== undefined) {
    fact.resolutionReason = resolutionReason;
  }
  if (resolution?.candidates) {
    fact.candidates = resolution.candidates;
  }
  return fact;
}

function stripCandidateConfidence(
  target: MarkdownCodeMentionTarget | MarkdownCodeMentionCandidate,
): MarkdownCodeMentionTarget {
  return {
    type: target.type,
    id: target.id,
    filePath: target.filePath,
  };
}
