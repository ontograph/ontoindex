import {
  createBufferedCsvRowWriter,
  type CsvRowWriterFactory,
} from '../core/lbug/csv-row-writer.js';
import {
  isNativeFeatureEnabled,
  loadOntoIndexNativeModule,
  type OntoIndexNativeModule,
} from './module.js';

export interface CsvWriterFactorySelectionOptions {
  env?: NodeJS.ProcessEnv;
  fallbackFactory?: CsvRowWriterFactory;
  loadNativeModule?: () => Promise<OntoIndexNativeModule>;
  onWarning?: (message: string) => void;
}

export const isNativeCsvEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  return isNativeFeatureEnabled(env, 'ONTOINDEX_NATIVE_CSV');
};

export const selectCsvRowWriterFactory = async (
  options: CsvWriterFactorySelectionOptions = {},
): Promise<CsvRowWriterFactory> => {
  const env = options.env ?? process.env;
  const fallbackFactory = options.fallbackFactory ?? createBufferedCsvRowWriter;
  if (!isNativeCsvEnabled(env)) return fallbackFactory;

  try {
    const nativeModule = await (options.loadNativeModule ?? loadOntoIndexNativeModule)();
    const nativeFactory = nativeModule.createCsvRowWriter ?? nativeModule.createNativeCsvRowWriter;
    if (typeof nativeFactory === 'function') return nativeFactory;
    options.onWarning?.(
      '[native-csv] ONTOINDEX_NATIVE_CSV is enabled, but the native module did not export a CSV writer factory; using TypeScript writer.',
    );
  } catch (err) {
    options.onWarning?.(
      `[native-csv] ONTOINDEX_NATIVE_CSV is enabled, but native CSV writer could not be loaded (${err instanceof Error ? err.message : String(err)}); using TypeScript writer.`,
    );
  }

  return fallbackFactory;
};
