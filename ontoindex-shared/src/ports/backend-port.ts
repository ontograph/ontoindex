/**
 * Unified repository handle.
 */
export interface RepoHandle {
  /** Unique identifier for this repository instance. */
  id: string;
  /** Human-readable name (usually the folder name). */
  name: string;
  /** Absolute path to the source repository on disk. */
  repoPath: string;
  /** Absolute path to the OntoIndex storage directory for this repo. */
  storagePath: string;
  /** Path to the LadybugDB database file. */
  lbugPath: string;
  /** ISO timestamp of the last full index. */
  indexedAt?: string;
  /** SHA of the last commit indexed. */
  lastCommit?: string;
  /** High-level repository statistics. */
  stats?: Record<string, number>;
}

/**
 * Unified interface for an OntoIndex backend (Local, Group, or Remote).
 */
export interface BackendPort {
  /** Initialize the backend and discover repositories. */
  init(): Promise<boolean>;
  /**
   * Execute an MCP tool by name.
   *
   * Provides a stable contract for the M-1 facade dispatch.
   */
  callTool(method: string, params: unknown): Promise<unknown>;
  /** Release all resources and close database connections. */
  dispose(): Promise<void>;
}

/**
 * Extended port for backends that support cross-repo group operations.
 */
export interface GroupBackendPort extends BackendPort {
  /** List all configured repository groups. */
  listGroups(): Promise<unknown>;
  /** Synchronize contracts within a group. */
  syncGroup(groupName: string): Promise<unknown>;
}
