import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { processCalls } from '../../src/core/ingestion/call-processor.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import { processParsing } from '../../src/core/ingestion/parsing-processor.js';

const consumer = {
  path: 'service.rb',
  content: `
# @param user [User]
def process_user(user)
  user.address.save
end
`,
};

const models = {
  path: 'models.rb',
  content: `
class Address
  def save
  end
end

class OtherAddress
  def save
  end
end

class User
  # @return [Address]
  attr_accessor :address
  attr_accessor :untyped
end

class OtherUser
  # @return [OtherAddress]
  attr_accessor :address
end
`,
};

describe('Ruby declared field order', () => {
  it.each(['consumer first', 'models first'] as const)(
    'publishes owner-qualified fields before resolving calls with %s',
    async (order) => {
      const files = order === 'consumer first' ? [consumer, models] : [models, consumer];
      const graph = createKnowledgeGraph();
      const cache = createASTCache();
      const ctx = createResolutionContext();
      try {
        await processParsing(graph, files, ctx.model.symbols, cache);

        const properties = graph.nodes.filter((node) => node.label === 'Property');
        expect(properties.map((node) => node.id).sort()).toEqual([
          'Property:models.rb:OtherUser.address',
          'Property:models.rb:User.address',
          'Property:models.rb:User.untyped',
        ]);
        expect(graph.getNode('Property:models.rb:User.address')?.properties.declaredType).toBe(
          'Address',
        );
        expect(graph.getNode('Property:models.rb:OtherUser.address')?.properties.declaredType).toBe(
          'OtherAddress',
        );
        expect(
          graph.getNode('Property:models.rb:User.untyped')?.properties.declaredType,
        ).toBeUndefined();
        for (const [owner, field] of [
          ['User', 'address'],
          ['User', 'untyped'],
          ['OtherUser', 'address'],
        ]) {
          expect(graph.relationships).toContainEqual(
            expect.objectContaining({
              type: 'HAS_PROPERTY',
              sourceId: `Class:models.rb:${owner}`,
              targetId: `Property:models.rb:${owner}.${field}`,
            }),
          );
        }

        const caller = graph.nodes.find(
          (node) =>
            node.properties.filePath === consumer.path && node.properties.name === 'process_user',
        );
        const addressMethods = graph.relationships.filter(
          (edge) => edge.type === 'HAS_METHOD' && edge.sourceId === 'Class:models.rb:Address',
        );
        const save = graph.nodes.find(
          (node) =>
            node.properties.name === 'save' &&
            addressMethods.some((edge) => edge.targetId === node.id),
        );
        expect(caller).toBeDefined();
        expect(save).toBeDefined();

        await processCalls(graph, files, cache, ctx);

        expect(
          graph.relationships.filter(
            (edge) => edge.type === 'CALLS' && edge.sourceId === caller!.id,
          ),
        ).toEqual([expect.objectContaining({ sourceId: caller!.id, targetId: save!.id })]);
        expect(
          graph.nodes
            .filter((node) => node.label === 'Property')
            .map((node) => node.id)
            .sort(),
        ).toEqual(properties.map((node) => node.id).sort());
      } finally {
        cache.clear();
        ctx.clear();
      }
    },
  );
});
