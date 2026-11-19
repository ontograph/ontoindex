import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fstat, read, close, type Stats } from 'node:fs';
import type { CsvRowWriterFactory } from '../core/lbug/csv-row-writer.js';

export interface NativeFileLock {
  release(): void;
}

export interface NativeRootedDirectory {
  /** Transfers ownership of one regular-file descriptor to the caller. */
  openRegularFile(relativePath: string): number;
  close(): void;
}

/** Adopt the descriptor transferred by the rooted opener without reopening its pathname. */
export async function openRootedFile(root: NativeRootedDirectory, relativePath: string) {
  const fd = root.openRegularFile(relativePath);
  let closing: Promise<void> | undefined;
  return {
    stat: () =>
      new Promise<Stats>((resolve, reject) => {
        fstat(fd, (error, stat) => (error ? reject(error) : resolve(stat)));
      }),
    read: (buffer: Buffer, offset: number, length: number, position: number | null) =>
      new Promise<{ bytesRead: number; buffer: Buffer }>((resolve, reject) => {
        read(fd, buffer, offset, length, position, (error, bytesRead) =>
          error ? reject(error) : resolve({ bytesRead, buffer }),
        );
      }),
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        close(fd, (error) => (error ? reject(error) : resolve()));
      })),
  };
}

export interface OntoIndexNativeModule {
  openRootedDirectory?: (root: string) => NativeRootedDirectory;
  tryAcquireFileLock?: (lockPath: string) => NativeFileLock | null;
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

const require = createRequire(import.meta.url);

export const truthyNativeFlag = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
};

export const isNativeFeatureEnabled = (env: NodeJS.ProcessEnv, featureFlag: string): boolean =>
  truthyNativeFlag(env[featureFlag]);

export const loadOntoIndexNativeModule = async (): Promise<OntoIndexNativeModule> => {
  const nativePlatform =
    process.platform === 'linux'
      ? `${process.platform}-${process.arch}`
      : process.platform === 'darwin' && process.arch === 'arm64'
        ? 'darwin-arm64'
        : null;
  if (!nativePlatform) {
    throw new Error(`OntoIndex native addon is unavailable on ${process.platform}/${process.arch}`);
  }
  return require(
    fileURLToPath(new URL(`../../dist/native/addon/${nativePlatform}/index.cjs`, import.meta.url)),
  ) as OntoIndexNativeModule;
};
