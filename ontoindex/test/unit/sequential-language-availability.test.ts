import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/tree-sitter/parser-loader.js', () => ({
  loadParser: vi.fn(async () => ({
    parse: vi.fn(),
    getLanguage: vi.fn(),
  })),
  loadLanguage: vi.fn(async () => undefined),
  isLanguageAvailable: vi.fn(() => true),
}));

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { processImports } from '../../src/core/ingestion/import-processor.js';
import { processCalls } from '../../src/core/ingestion/call-processor.js';
import {
  processHeritage,
  extractExtractedHeritageFromFiles,
} from '../../src/core/ingestion/heritage-processor.js';
import { createResolutionContext } from '../../src/core/ingestion/model/resolution-context.js';
import * as parserLoader from '../../src/core/tree-sitter/parser-loader.js';

describe('sequential native parser availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(true);
  });

  it('marks heritage evidence incomplete when its language is unavailable', async () => {
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);
    const onIncomplete = vi.fn();
    await expect(
      extractExtractedHeritageFromFiles(
        [{ path: 'App.swift', content: 'class App: Base {}' }],
        createASTCache(),
        onIncomplete,
      ),
    ).resolves.toEqual([]);
    expect(onIncomplete).toHaveBeenCalledOnce();
    expect(parserLoader.loadLanguage).not.toHaveBeenCalled();
  });

  it.each(['parse', 'query'] as const)(
    'marks swallowed %s failures as incomplete heritage evidence',
    async (stage) => {
      const parser = await parserLoader.loadParser();
      vi.mocked(parser.parse).mockImplementation(() => {
        if (stage === 'parse') throw new Error('injected parse failure');
        return { rootNode: {} } as ReturnType<typeof parser.parse>;
      });
      vi.mocked(parserLoader.loadParser).mockResolvedValueOnce(parser);
      const onIncomplete = vi.fn();
      await expect(
        extractExtractedHeritageFromFiles(
          [{ path: 'app.rb', content: 'class App < Base\nend' }],
          createASTCache(),
          onIncomplete,
        ),
      ).resolves.toEqual([]);
      expect(onIncomplete).toHaveBeenCalledOnce();
      if (stage === 'query') expect(parser.getLanguage).toHaveBeenCalledOnce();
    },
  );

  it('skips Swift files in processImports when the native parser is unavailable', async () => {
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

    await expect(
      processImports(
        createKnowledgeGraph(),
        [{ path: 'App.swift', content: 'import Foundation' }],
        createASTCache(),
        createResolutionContext(),
        undefined,
        '/tmp/repo',
        ['App.swift'],
      ),
    ).resolves.toBeUndefined();

    expect(parserLoader.loadLanguage).not.toHaveBeenCalled();
  });

  it('warns when processImports skips files in verbose mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = process.env.ONTOINDEX_VERBOSE;
    process.env.ONTOINDEX_VERBOSE = '1';
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

    await processImports(
      createKnowledgeGraph(),
      [{ path: 'App.swift', content: 'import Foundation' }],
      createASTCache(),
      createResolutionContext(),
      undefined,
      '/tmp/repo',
      ['App.swift'],
    );

    expect(warnSpy).toHaveBeenCalledWith(
      '[ingestion] Skipped 1 swift file(s) in import processing — swift parser not available.',
    );

    warnSpy.mockRestore();
    if (previous === undefined) {
      delete process.env.ONTOINDEX_VERBOSE;
    } else {
      process.env.ONTOINDEX_VERBOSE = previous;
    }
  });

  it('skips Swift files in processCalls when the native parser is unavailable', async () => {
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);
    const onIncomplete = vi.fn();

    await expect(
      processCalls(
        createKnowledgeGraph(),
        [{ path: 'App.swift', content: 'func demo() {}' }],
        createASTCache(),
        createResolutionContext(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onIncomplete,
      ),
    ).resolves.toEqual([]);

    expect(onIncomplete).toHaveBeenCalledOnce();
    expect(parserLoader.loadLanguage).not.toHaveBeenCalled();
  });

  it.each(['parse', 'query'] as const)(
    'marks swallowed %s failures as incomplete call evidence',
    async (stage) => {
      const parser = await parserLoader.loadParser();
      vi.mocked(parser.parse).mockImplementation(() => {
        if (stage === 'parse') throw new Error('injected parse failure');
        return { rootNode: {} } as ReturnType<typeof parser.parse>;
      });
      vi.mocked(parserLoader.loadParser).mockResolvedValueOnce(parser);
      const onIncomplete = vi.fn();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await expect(
          processCalls(
            createKnowledgeGraph(),
            [{ path: 'app.ts', content: 'target();' }],
            createASTCache(),
            createResolutionContext(),
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            onIncomplete,
          ),
        ).resolves.toEqual([]);
        expect(onIncomplete).toHaveBeenCalledOnce();
        if (stage === 'query') expect(parser.getLanguage).toHaveBeenCalledOnce();
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('warns when processCalls skips files in verbose mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = process.env.ONTOINDEX_VERBOSE;
    process.env.ONTOINDEX_VERBOSE = '1';
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

    await processCalls(
      createKnowledgeGraph(),
      [{ path: 'App.swift', content: 'func demo() {}' }],
      createASTCache(),
      createResolutionContext(),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      '[ingestion] Skipped 1 swift file(s) in call processing — swift parser not available.',
    );

    warnSpy.mockRestore();
    if (previous === undefined) {
      delete process.env.ONTOINDEX_VERBOSE;
    } else {
      process.env.ONTOINDEX_VERBOSE = previous;
    }
  });

  it('skips Swift files in processHeritage when the native parser is unavailable', async () => {
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

    await expect(
      processHeritage(
        createKnowledgeGraph(),
        [{ path: 'App.swift', content: 'class AppViewController: UIViewController {}' }],
        createASTCache(),
        createResolutionContext(),
      ),
    ).resolves.toBeUndefined();

    expect(parserLoader.loadLanguage).not.toHaveBeenCalled();
  });

  it('warns when processHeritage skips files in verbose mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previous = process.env.ONTOINDEX_VERBOSE;
    process.env.ONTOINDEX_VERBOSE = '1';
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);

    await processHeritage(
      createKnowledgeGraph(),
      [{ path: 'App.swift', content: 'class AppViewController: UIViewController {}' }],
      createASTCache(),
      createResolutionContext(),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      '[ingestion] Skipped 1 swift file(s) in heritage processing — swift parser not available.',
    );

    warnSpy.mockRestore();
    if (previous === undefined) {
      delete process.env.ONTOINDEX_VERBOSE;
    } else {
      process.env.ONTOINDEX_VERBOSE = previous;
    }
  });
});
