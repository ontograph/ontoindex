import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { processCalls } from '../../src/core/ingestion/call-processor.js';
import { processAssignmentsFromExtracted } from '../../src/core/ingestion/call-resolution/assignment-processor.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import type {
  ExtractedAssignment,
  ExtractedCall,
  FileConstructorBindings,
} from '../../src/core/ingestion/workers/parse-worker.js';

describe('sequential assignment retention coverage', () => {
  it.each(['ts', 'tsx', 'js', 'jsx'])(
    '%s retains original writes once and preserves calls on assignment right-hand sides',
    async (extension) => {
      const file = {
        path: `src/assignments.${extension}`,
        content: [
          'class Service {}',
          'function target() { return 1; }',
          'function caller() {',
          '  const service = new Service();',
          '  service.value = target();',
          '  unknown.value = 2;',
          '  Service.staticValue = 3;',
          '}',
        ].join('\n'),
      };
      const callerId = `Function:${file.path}:caller`;
      const classId = `Class:${file.path}:Service`;
      const setup = () => {
        const graph = createKnowledgeGraph();
        const ctx = createResolutionContext();
        ctx.model.symbols.add(file.path, 'caller', callerId, 'Function');
        ctx.model.symbols.add(file.path, 'target', `Function:${file.path}:target`, 'Function');
        ctx.model.symbols.add(file.path, 'Service', classId, 'Class');
        for (const property of ['value', 'staticValue']) {
          ctx.model.symbols.add(
            file.path,
            property,
            `Property:${file.path}:${property}`,
            'Property',
            {
              ownerId: classId,
            },
          );
        }
        return { graph, ctx, cache: createASTCache() };
      };
      const baseline = setup();
      const observed = setup();
      const replay = setup();
      const assignments: ExtractedAssignment[] = [];
      const calls: ExtractedCall[] = [];
      const constructors: FileConstructorBindings[] = [];
      const writes = (graph: ReturnType<typeof createKnowledgeGraph>) =>
        graph.relationships
          .filter((edge) => edge.type === 'ACCESSES' && edge.reason === 'write')
          .sort((left, right) => left.id.localeCompare(right.id));
      try {
        const baselineHeritage = await processCalls(
          baseline.graph,
          [file],
          baseline.cache,
          baseline.ctx,
        );
        const observedHeritage = await processCalls(
          observed.graph,
          [file],
          observed.cache,
          observed.ctx,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          (call) => calls.push(call),
          (assignment) => assignments.push(assignment),
          (bindings) => constructors.push(bindings),
        );
        expect(observedHeritage).toEqual(baselineHeritage);
        expect(observed.graph.nodes).toEqual(baseline.graph.nodes);
        expect(observed.graph.relationships).toEqual(baseline.graph.relationships);
        expect(assignments).toEqual([
          {
            filePath: file.path,
            sourceId: callerId,
            receiverText: 'service',
            propertyName: 'value',
            receiverTypeName: 'Service',
          },
          {
            filePath: file.path,
            sourceId: callerId,
            receiverText: 'unknown',
            propertyName: 'value',
          },
          {
            filePath: file.path,
            sourceId: callerId,
            receiverText: 'Service',
            propertyName: 'staticValue',
          },
        ]);
        expect(Object.hasOwn(assignments[1]!, 'receiverTypeName')).toBe(false);
        // The class receiver is resolved only after the original assignment is captured.
        expect(Object.hasOwn(assignments[2]!, 'receiverTypeName')).toBe(false);
        expect(calls).toEqual([
          {
            filePath: file.path,
            sourceId: callerId,
            calledName: 'Service',
            callForm: 'constructor',
            argCount: 0,
            atRange: { startLine: 4, startCol: 18, endLine: 4, endCol: 31 },
          },
          {
            filePath: file.path,
            sourceId: callerId,
            calledName: 'target',
            callForm: 'free',
            argCount: 0,
            atRange: { startLine: 5, startCol: 18, endLine: 5, endCol: 26 },
          },
        ]);
        expect(observed.graph.relationships.filter((edge) => edge.type === 'CALLS')).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sourceId: callerId,
              targetId: `Function:${file.path}:target`,
            }),
          ]),
        );
        expect(writes(observed.graph)).toHaveLength(2);
        expect(writes(observed.graph)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sourceId: callerId,
              targetId: `Property:${file.path}:staticValue`,
            }),
            expect.objectContaining({
              sourceId: callerId,
              targetId: `Property:${file.path}:value`,
            }),
          ]),
        );
        processAssignmentsFromExtracted(replay.graph, assignments, replay.ctx, constructors);
        expect(writes(replay.graph)).toEqual(writes(observed.graph));
      } finally {
        baseline.cache.clear();
        observed.cache.clear();
        replay.cache.clear();
      }
    },
  );
});
