import { loadOntoIndexNativeModule, isNativeFeatureEnabled } from './module.js';

export interface HeritageRelation {
  childId: string;
  parentId: string;
}

/**
 * Adapter for the high-performance NativeHeritageMap (Phase 5).
 *
 * Provides a Rust-accelerated directed acyclic graph (DAG) for class/interface
 * inheritance and method resolution order (MRO).
 */
export class NativeHeritageMapAdapter {
  private nativeInstance: any = null;

  static async create(env: NodeJS.ProcessEnv): Promise<NativeHeritageMapAdapter | null> {
    if (!isNativeFeatureEnabled(env, 'ONTOINDEX_NATIVE_HERITAGE')) {
      return null;
    }

    try {
      const native = await loadOntoIndexNativeModule();
      if (native.NativeHeritageMap) {
        const adapter = new NativeHeritageMapAdapter();
        adapter.nativeInstance = new native.NativeHeritageMap();
        return adapter;
      }
    } catch (err) {
      console.warn('[native] Failed to load NativeHeritageMap:', err);
    }
    return null;
  }

  addRelation(childId: string, parentId: string): void {
    this.nativeInstance.addRelation(childId, parentId);
  }

  getParents(childId: string): string[] {
    return this.nativeInstance.getParents(childId);
  }

  getAncestors(childId: string): string[] {
    return this.nativeInstance.getAncestors(childId);
  }

  isSubclassOf(childId: string, parentId: string): boolean {
    return this.nativeInstance.isSubclassOf(childId, parentId);
  }
}
