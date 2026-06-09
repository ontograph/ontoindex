/**
 * Integration Tests: ORM Dataflow Detection (Prisma + Supabase)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const ORM_REPO = path.resolve(__dirname, '..', 'fixtures', 'orm-repo');

describe('ORM dataflow detection', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(ORM_REPO, () => {});
  }, 60000);

  it('creates QUERIES edges for Prisma calls', () => {
    const queryEdges: { source: string; target: string; reason: string }[] = [];
    for (const rel of result.graph.iterRelationships()) {
      if (rel.type === 'QUERIES') {
        const source = result.graph.getNode(rel.sourceId);
        const target = result.graph.getNode(rel.targetId);
        if (source && target) {
          queryEdges.push({
            source: source.properties.filePath || source.properties.name,
            target: target.properties.name,
            reason: rel.reason ?? '',
          });
        }
      }
    }
    const prismaEdges = queryEdges.filter((e) => e.source.includes('prisma-service'));
    const prismaModels = [...new Set(prismaEdges.map((e) => e.target))];
    expect(prismaModels).toContain('user');
    expect(prismaModels).toContain('post');
    const reasons = prismaEdges.map((e) => e.reason);
    expect(reasons.some((r) => r.includes('prisma-findMany'))).toBe(true);
    expect(reasons.some((r) => r.includes('prisma-create'))).toBe(true);
  });

  it('creates QUERIES edges for Supabase calls', () => {
    const queryEdges: { source: string; target: string; reason: string }[] = [];
    for (const rel of result.graph.iterRelationships()) {
      if (rel.type === 'QUERIES') {
        const source = result.graph.getNode(rel.sourceId);
        const target = result.graph.getNode(rel.targetId);
        if (source && target) {
          queryEdges.push({
            source: source.properties.filePath || source.properties.name,
            target: target.properties.name,
            reason: rel.reason ?? '',
          });
        }
      }
    }
    const supabaseEdges = queryEdges.filter((e) => e.source.includes('supabase-service'));
    const supabaseModels = [...new Set(supabaseEdges.map((e) => e.target))];
    expect(supabaseModels).toContain('bookings');
    expect(supabaseModels).toContain('interpreters');
    expect(supabaseModels).toContain('sessions');
    const reasons = supabaseEdges.map((e) => e.reason);
    expect(reasons.some((r) => r.includes('supabase-select'))).toBe(true);
    expect(reasons.some((r) => r.includes('supabase-insert'))).toBe(true);
  });

  it('creates CodeElement nodes for ORM models', () => {
    const codeElements: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'CodeElement' && n.properties.description?.includes('model/table')) {
        codeElements.push(n.properties.name);
      }
    });
    expect(codeElements).toContain('user');
    expect(codeElements).toContain('post');
    expect(codeElements).toContain('bookings');
    expect(codeElements).toContain('interpreters');
    expect(codeElements).toContain('sessions');
  });

  it('uses orm-model pack client identifiers in the sequential fallback path', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontoindex-orm-pack-'));
    try {
      fs.mkdirSync(path.join(repoDir, 'ontoindex-packs/core/framework-models'), {
        recursive: true,
      });
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, 'ontoindex-packs/core/framework-models/pack.yml'),
        [
          'schema: 1',
          'id: core.framework-models',
          'name: Framework Models',
          'version: 0.1.0',
          'kind: model',
          'tier: experimental',
          'summary: Framework models.',
          'provides:',
          '  - orm-models',
          'prismaClientIdentifiers:',
          '  - db',
          'supabaseClientIdentifiers:',
          '  - adminDb',
          'runs: []',
        ].join('\n'),
        'utf8',
      );
      fs.writeFileSync(
        path.join(repoDir, 'src', 'orm-service.ts'),
        [
          'export async function listUsers() {',
          '  return db.user.findMany({ where: { active: true } });',
          '}',
          '',
          'export async function listBookings() {',
          "  return adminDb.from('bookings').select('*');",
          '}',
          '',
        ].join('\n'),
        'utf8',
      );

      const aliasResult = await runPipelineFromRepo(repoDir, () => {}, {
        skipWorkers: true,
        skipGraphPhases: true,
      });

      const queryEdges: { target: string; reason: string }[] = [];
      for (const rel of aliasResult.graph.iterRelationships()) {
        if (rel.type !== 'QUERIES') continue;
        const target = aliasResult.graph.getNode(rel.targetId);
        if (!target) continue;
        queryEdges.push({
          target: String(target.properties.name),
          reason: rel.reason ?? '',
        });
      }

      expect(queryEdges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target: 'user', reason: 'prisma-findMany' }),
          expect.objectContaining({ target: 'bookings', reason: 'supabase-select' }),
        ]),
      );
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
