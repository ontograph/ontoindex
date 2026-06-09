import type { CsvRowWriterFactory } from '../core/lbug/csv-row-writer.js';

export interface OntoIndexNativeModule {
  createCsvRowWriter?: CsvRowWriterFactory;
  createNativeCsvRowWriter?: CsvRowWriterFactory;
  NativeHeritageMap?: {
    new (): {
      addRelation(childId: string, parentId: string): void;
      getParents(childId: string): string[];
      getAncestors(childId: string): string[];
      isSubclassOf(childId: string, parentId: string): boolean;
    };
  };
  writeCsvRecords?: (csvPath: string, headers: string[], records: string[][]) => number;
  writeGraphBatchNative?: (csvDir: string, nodes: unknown[], relationships: unknown[]) => void;
}

const nativePackageName = 'ontoindex-native';

export const truthyNativeFlag = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
};

export const isNativeFeatureEnabled = (env: NodeJS.ProcessEnv, featureFlag: string): boolean =>
  truthyNativeFlag(env[featureFlag]);

export const loadOntoIndexNativeModule = async (): Promise<OntoIndexNativeModule> => {
  return (await import(nativePackageName)) as OntoIndexNativeModule;
};
