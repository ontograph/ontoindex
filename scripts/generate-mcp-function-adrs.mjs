import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs', 'adr', 'mcp-functions');
const registryModule = pathToFileURL(
  path.join(root, 'ontoindex', 'dist', 'mcp', 'shared', 'tool-registry.js'),
).href;

const { getPublicToolRegistry } = await import(registryModule);

const entries = getPublicToolRegistry({
  includeFacades: true,
  startupProfile: 'public-full',
}).sort((a, b) => a.name.localeCompare(b.name));

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function sentence(value) {
  const text = String(value || '').trim();
  if (!text) return 'Not declared.';
  return text.endsWith('.') ? text : `${text}.`;
}

function sentenceNoTerminal(value) {
  return String(value || '')
    .trim()
    .replace(/[.!?]+$/g, '');
}

function firstParagraph(value) {
  return (
    String(value || '')
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean)[0] ?? 'No description is declared in the MCP registry.'
  );
}

function properties(entry) {
  return entry.definition?.inputSchema?.properties ?? {};
}

function required(entry) {
  return new Set(entry.definition?.inputSchema?.required ?? []);
}

function propertyRows(entry) {
  const props = properties(entry);
  const requiredProps = required(entry);
  const names = Object.keys(props).sort();
  if (names.length === 0) {
    return '| Parameter | Type | Required | Purpose |\n| --- | --- | --- | --- |\n| none | n/a | no | This function has no declared input parameters. |';
  }

  return [
    '| Parameter | Type | Required | Purpose |',
    '| --- | --- | --- | --- |',
    ...names.map((name) => {
      const prop = props[name] ?? {};
      const type = prop.enum ? `${prop.type}: ${prop.enum.join(', ')}` : prop.type || 'unknown';
      const description = String(prop.description || '').trim();
      const hasDefaultInDescription = /\bdefault\b/i.test(description);
      const defaultText =
        prop.default !== undefined && !hasDefaultInDescription
          ? ` Default: ${JSON.stringify(prop.default)}.`
          : '';
      const purpose = String(
        description || defaultText ? `${description}${defaultText}` : 'No description declared.',
      )
        .replace(/\s+/g, ' ')
        .trim();
      return `| \`${name}\` | ${type} | ${requiredProps.has(name) ? 'yes' : 'no'} | ${purpose.replace(/\|/g, '\\|')} |`;
    }),
  ].join('\n');
}

function exampleValue(name, prop, requiredValue) {
  if (name === 'repo') return 'my-repo';
  if (name === 'query') return 'authentication flow';
  if (name === 'symbol' || name === 'target' || name === 'seedSymbol') return 'validateUser';
  if (name === 'filePath' || name === 'path') return 'src/auth/validate-user.ts';
  if (name === 'scope') return 'staged';
  if (name === 'action') return Array.isArray(prop.enum) ? prop.enum[0] : 'status';
  if (name === 'intent')
    return Array.isArray(prop.enum) ? prop.enum[0] : 'add audit-safe auth middleware';
  if (name === 'level') return 'balanced';
  if (name === 'session' || name === 'sessionId') return 'audit-session-001';
  if (name === 'bundleId') return 'bundle-001';
  if (name === 'resource') return 'fd';
  if (name === 'start') return 'openConfig';
  if (name === 'when') return 'fork() < 0';
  if (name === 'source') return 'request.body';
  if (name === 'sink') return 'exec';
  if (name === 'targetCall' || name === 'target') return 'validateUser';
  if (name === 'returnValue' || name === 'return_value') return '-1';
  if (prop.type === 'boolean') return requiredValue ?? true;
  if (prop.type === 'number') return prop.default ?? prop.minimum ?? 1;
  if (prop.type === 'array') return ['example'];
  if (prop.type === 'object') return { example: true };
  if (Array.isArray(prop.enum)) return prop.enum[0];
  return requiredValue ?? 'example';
}

function sampleInput(entry) {
  const props = properties(entry);
  const req = required(entry);
  const input = {};

  for (const name of Object.keys(props)) {
    if (req.has(name) || name === 'repo' || name === 'limit' || name === 'maxItems') {
      input[name] = exampleValue(name, props[name]);
    }
  }

  if (entry.kind === 'facade' && !input.action && props.action?.enum?.length) {
    input.action = props.action.enum[0];
  }

  return input;
}

function predecessor(entry) {
  if (entry.replacement)
    return `Supersedes or replaces \`${entry.replacement}\` in the public MCP contract.`;
  if (entry.fallback)
    return `Falls back to ${entry.fallback} when the preferred evidence path is unavailable.`;
  if (entry.kind === 'facade') {
    const actions = (entry.actions ?? []).map((action) => action.action).join(', ');
    return `Consolidates earlier direct backend actions into the \`${entry.name}\` facade. Current action set: ${actions || 'not declared'}.`;
  }
  if (entry.name.startsWith('gn_safe_')) {
    return 'Evolved from direct impact and refactor primitives into a graph-aware safety gate.';
  }
  if (entry.name.startsWith('gn_audit_session_')) {
    return 'Evolved from standalone audit ingest, verify, dedupe, bundle, dispatch, and review calls into a manager-loop lifecycle function.';
  }
  if (entry.category === 'systems-audit') {
    return 'Extends the audit layer with systems-programming analyzers for resource, concurrency, ABI, taint, and fault evidence.';
  }
  if (entry.category === 'docs') {
    return 'Extends raw graph and markdown evidence into bounded documentation-readiness workflows.';
  }
  return 'Predecessor is the lower-level graph query, impact, audit, or backend action surface that existed before the public super-function/facade contract.';
}

function informationReturned(entry) {
  const base = new Set();
  for (const klass of entry.producesEvidenceClasses ?? []) base.add(klass);
  const actions = entry.actions?.map((action) => `\`${action.action}\``).join(', ');
  const lines = [
    `- Category: \`${entry.category}\`.`,
    `- Evidence classes: ${base.size ? [...base].map((item) => `\`${item}\``).join(', ') : 'not declared'}.`,
    `- Response style: ${entry.structuredOutput ? 'structured JSON suitable for automation' : 'text or mixed output intended for direct agent use'}.`,
    `- Permission profile: \`${entry.permissionProfile ?? 'not_declared'}\`.`,
  ];
  if (actions) lines.push(`- Facade actions: ${actions}.`);
  lines.push(`- Typical result: ${sentenceNoTerminal(entry.intent)}; ${sentence(entry.whenToUse)}`);
  return lines.join('\n');
}

function adrBody(entry, index) {
  const name = entry.name;
  const title = `ADR-MCP-${String(index + 1).padStart(3, '0')}: ${name}`;
  const example = {
    tool: name,
    arguments: sampleInput(entry),
  };
  const responseExample = {
    status: 'ok',
    tool: name,
    summary: entry.intent,
    evidenceClasses: entry.producesEvidenceClasses ?? [],
    nextAction: entry.whenToUse,
  };

  return `# ${title}

## Status

Accepted.

## Function

\`${name}\`

## SEO Summary

OntoIndex MCP function \`${name}\` supports ${entry.intent.toLowerCase()} for AI coding agents, local code graph analysis, repository safety workflows, and Model Context Protocol automation.

## Context

${firstParagraph(entry.definition?.description)}

## Decision

Document \`${name}\` as a public OntoIndex MCP function because agents and human operators need a stable, linkable explanation of its purpose, predecessor surface, call shape, and returned evidence.

## Predecessors

${predecessor(entry)}

## How To Use

Call this function through an MCP client connected to the OntoIndex server.

\`\`\`json
${JSON.stringify(example, null, 2)}
\`\`\`

## What Information You Can Get

${informationReturned(entry)}

## Parameters

${propertyRows(entry)}

## Returning Answer Shape

Actual responses depend on repository state, index freshness, and requested limits. A minimal expected shape is:

\`\`\`json
${JSON.stringify(responseExample, null, 2)}
\`\`\`

## When It Is Useful

${sentence(entry.whenToUse)}

## Operational Notes

- Kind: \`${entry.kind}\`.
- Contract status: \`${entry.contractStatus}\`.
- Discoverable modes: ${(entry.modes ?? []).map((mode) => `\`${mode}\``).join(', ')}.
- Audit authority: \`${entry.auditAuthority}\`.
- Advisory-only: \`${entry.advisoryOnly}\`.
- Source of truth: \`ontoindex/src/mcp/shared/tool-registry.ts\` and \`ontoindex/src/mcp/*/tool-definitions.ts\`.

## Related Concepts

OntoIndex, MCP server, code graph, AI coding agent, static analysis, repository impact analysis, ${entry.category}, ${name}.
`;
}

function indexBody(files) {
  const rows = files
    .map(
      ({ entry, file }) =>
        `| \`${entry.name}\` | ${entry.kind} | ${entry.category} | ${entry.contractStatus} | [ADR](./${file}) |`,
    )
    .join('\n');
  return `# ADR-MCP Index: OntoIndex MCP Function Pages

## Status

Accepted.

## Purpose

This directory contains one ADR-style Markdown page per public OntoIndex MCP function. The pages are generated from the MCP registry so search engines and human readers can discover what each function does, which predecessor surface it replaces or consolidates, how to call it, and what information it returns.

## Function Pages

| Function | Kind | Category | Status | Page |
| --- | --- | --- | --- | --- |
${rows}

## Source Of Truth

- \`ontoindex/src/mcp/shared/tool-registry.ts\`
- \`ontoindex/src/mcp/super/tool-definitions.ts\`
- \`ontoindex/src/mcp/facade/tool-definitions.ts\`
`;
}

await mkdir(outDir, { recursive: true });

const files = [];
for (const [index, entry] of entries.entries()) {
  const file = `${String(index + 1).padStart(3, '0')}-${slug(entry.name)}.md`;
  files.push({ entry, file });
  await writeFile(path.join(outDir, file), adrBody(entry, index), 'utf8');
}

await writeFile(path.join(outDir, '0000-index.md'), indexBody(files), 'utf8');

console.log(`Generated ${files.length} MCP function ADR pages in ${path.relative(root, outDir)}`);
