import { describe, expect, it, vi, beforeEach } from 'vitest';

const lspMocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../../src/core/lsp/client.js', () => ({
  LSPClient: vi.fn().mockImplementation(function () {
    return {
      start: lspMocks.start,
      stop: lspMocks.stop,
      findDefinition: vi.fn(),
    };
  }),
}));

import { LSPClient } from '../../src/core/lsp/client.js';
import { LSPBridge } from '../../src/core/lsp/bridge.js';

describe('LSPBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deduplicates concurrent starts for the same extension', async () => {
    let releaseStart: (() => void) | undefined;
    lspMocks.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    );
    const bridge = new LSPBridge();

    const first = bridge.getClient('.ts');
    const second = bridge.getClient('.ts');
    await Promise.resolve();

    expect(LSPClient).toHaveBeenCalledTimes(1);
    expect(lspMocks.start).toHaveBeenCalledTimes(1);

    releaseStart?.();
    const [firstClient, secondClient] = await Promise.all([first, second]);

    expect(firstClient).toBe(secondClient);
    await bridge.stopAll();
    expect(lspMocks.stop).toHaveBeenCalledTimes(1);
  });
});
