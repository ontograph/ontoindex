import { expect, it } from 'vitest';
import { NODE_TABLES } from 'ontoindex-shared';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { executeQuery } from '../../src/core/lbug/lbug-adapter.js';
import {
  buildExportableGraph,
  getExportableGraphNodeQuery,
} from '../../src/core/graph/exportable-graph.js';

withTestLbugDB('exportable-graph-schema', () => {
  it('executes every table projection against the native schema with and without content', async () => {
    for (const includeContent of [false, true]) {
      for (const table of NODE_TABLES) {
        await expect(
          executeQuery(getExportableGraphNodeQuery(table, includeContent)),
        ).resolves.toEqual([]);
      }
    }
  });

  it('preserves concept and summary nodes in full graph exports', async () => {
    await executeQuery(
      "CREATE (:Concept {id: 'concept-export', name: 'Concept', filePath: 'docs.md'})",
    );
    await executeQuery(
      "CREATE (:SummaryNode {id: 'summary-export', name: 'Summary', filePath: 'docs.md', description: 'Overview'})",
    );
    for (const includeContent of [false, true]) {
      const graph = await buildExportableGraph(executeQuery, { includeContent });
      expect(graph.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'concept-export', label: 'Concept' }),
          expect.objectContaining({
            id: 'summary-export',
            label: 'SummaryNode',
            properties: expect.objectContaining({ description: 'Overview' }),
          }),
        ]),
      );
    }
  });
});
