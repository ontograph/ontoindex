import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPublicToolRegistry } from '../../src/mcp/shared/tool-registry.js';
import { serializeToolContract } from '../../src/mcp/shared/tool-contract-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/mcp-tool-contract');
const SNAPSHOT_PATH = path.join(FIXTURE_DIR, 'stable-tools.snapshot.json');

describe('tool-contract-schema — snapshot (Phase 3)', () => {
  it('generates a deterministic snapshot of stable tool contracts', () => {
    const registry = getPublicToolRegistry({ includeFacades: true });
    const schema = serializeToolContract(registry, { includeExperimental: false });
    const comparableSchema = stripAdr28SourceMetadata(schema);
    const shouldUpdateSnapshots = process.env.UPDATE_SNAPSHOTS === '1';

    if (!fs.existsSync(FIXTURE_DIR)) {
      if (!shouldUpdateSnapshots) {
        throw new Error(
          `Snapshot fixture directory missing at ${FIXTURE_DIR}. Run 'UPDATE_SNAPSHOTS=1 npm test -- test/unit/tool-contract-schema.test.ts' to generate it.`,
        );
      }
      fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    }

    const snapshotContent = JSON.stringify(comparableSchema, null, 2);

    if (!fs.existsSync(SNAPSHOT_PATH)) {
      if (shouldUpdateSnapshots) {
        fs.writeFileSync(SNAPSHOT_PATH, snapshotContent, 'utf-8');
      } else {
        throw new Error(
          `Snapshot fixture missing at ${SNAPSHOT_PATH}. Run 'UPDATE_SNAPSHOTS=1 npm test -- test/unit/tool-contract-schema.test.ts' to generate it.`,
        );
      }
    } else if (shouldUpdateSnapshots) {
      fs.writeFileSync(SNAPSHOT_PATH, snapshotContent, 'utf-8');
    }

    const existingSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));

    // If they differ, the test fails. This forces developers to intentionally
    // update the snapshot when contracts change. Compare semantic JSON so the
    // repository formatter can own fixture whitespace.
    expect(existingSnapshot).toEqual(comparableSchema);
  });

  it('omits experimental tools from the stable snapshot', () => {
    const registry = getPublicToolRegistry({ includeFacades: true });

    // Find an experimental tool if any exists
    const experimentalEntry = registry.find((e) => e.contractStatus === 'experimental');

    const schema = serializeToolContract(registry, { includeExperimental: false });

    if (experimentalEntry) {
      expect(schema.tools.map((t) => t.name)).not.toContain(experimentalEntry.name);
    }
  });

  it('serializes ADR26 registry metadata fields in tool contract output', () => {
    const registry = getPublicToolRegistry({ includeFacades: true });
    const schema = serializeToolContract(registry, { includeExperimental: false });
    const tool = schema.tools.find((entry) => entry.name === 'gn_docs');

    expect(tool).toBeDefined();
    expect(Array.isArray(tool?.workflowIntents)).toBe(true);
    expect(Array.isArray(tool?.producesEvidenceClasses)).toBe(true);
    expect(typeof tool?.auditAuthority).toBe('boolean');
    expect(typeof tool?.advisoryOnly).toBe('boolean');
    expect(typeof tool?.permissionProfile).toBe('string');
  });

  it('serializes ADR28 evidence source metadata deterministically', () => {
    const registry = getPublicToolRegistry({ includeFacades: true });
    const schema = serializeToolContract(registry, { includeExperimental: false });
    const docsTool = schema.tools.find((entry) => entry.name === 'gn_docs');
    const auditTool = schema.tools.find((entry) => entry.name === 'gn_audit_verify');

    expect(docsTool?.evidenceSources).toEqual([
      {
        evidenceClass: 'advisory_memory',
        freshnessBehavior: 'memory_freshness_declared',
        auditAuthority: false,
        provenanceFields: ['memoryId', 'memoryFreshness', 'notAuditEvidence'],
        truncationPolicy: 'caller_limited_response',
        responsePolicy: 'structured_response',
        safeForBasedOnReads: false,
        advisoryOnly: true,
      },
      {
        evidenceClass: 'docs_evidence',
        freshnessBehavior: 'docs_policy_checked',
        auditAuthority: false,
        provenanceFields: ['repo', 'path', 'commit', 'section', 'freshness'],
        truncationPolicy: 'caller_limited_response',
        responsePolicy: 'structured_response',
        safeForBasedOnReads: true,
        advisoryOnly: true,
      },
    ]);

    expect(
      auditTool?.evidenceSources?.find((source) => source.evidenceClass === 'audit_evidence'),
    ).toMatchObject({
      auditAuthority: true,
      safeForBasedOnReads: true,
      advisoryOnly: false,
    });
  });
});

function stripAdr28SourceMetadata(schema: ReturnType<typeof serializeToolContract>) {
  return {
    ...schema,
    tools: schema.tools.map(({ evidenceSources: _evidenceSources, ...tool }) => tool),
  };
}
