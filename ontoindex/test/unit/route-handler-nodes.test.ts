import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/lbug/pool-adapter.js', () => ({ executeParameterized: query }));
import { fetchRoutesWithConsumers } from '../../src/mcp/local/backend-overview.js';

describe('route handler graph evidence', () => {
  beforeEach(() => query.mockReset());
  it('returns distinct resolved methods without duplicating consumers', async () => {
    query.mockResolvedValueOnce([{ routeId: 'Route:GET /items', routeName: '/items', handlerFile: 'web/index.php', consumerName: 'client', consumerFile: 'web/js/client.js' }]);
    query.mockResolvedValueOnce([
      { routeId: 'Route:GET /items', handlerId: 'Method:Items.index', handlerName: 'index', handlerFile: 'src/Items.php' },
      { routeId: 'Route:GET /items', handlerId: 'Method:Items.index', handlerName: 'index', handlerFile: 'src/Items.php' },
    ]);
    const routes = await fetchRoutesWithConsumers('repo', '', {});
    expect(routes[0].handlerNodes).toEqual([{ id: 'Method:Items.index', name: 'index', filePath: 'src/Items.php' }]);
    expect(routes[0].consumers).toHaveLength(1);
  });
});
