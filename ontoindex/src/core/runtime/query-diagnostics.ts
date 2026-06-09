import type { QueryBudgetSnapshot, QueryTokenCostSnapshot } from './query-budget.js';
import type { EvidenceDiagnosticRecord } from './evidence-diagnostics.js';

export type QueryFreshnessStatus = 'fresh' | 'stale' | 'degraded' | 'unknown' | 'not-applicable';

export interface QueryFreshnessState {
  status: QueryFreshnessStatus;
  actionable: boolean;
  reason: string;
  targetHead?: string;
  currentHead?: string;
  indexedHead?: string;
  snapshotMode?: string;
}

export interface QueryCapabilityHealth {
  capabilitiesUsed: string[];
  capabilitiesMissing: string[];
  warnings: string[];
  lanes?: Record<string, { status: LaneStatus; reason?: string }>;
  embeddingModelHash?: string;
  tokenCost?: QueryTokenCostSnapshot;
  cacheHit?: boolean;
  cacheStatus?: 'hit' | 'miss' | 'stale' | 'expired';
  cacheAgeMs?: number;
  cacheEvictedEntries?: number;
}

export type LaneStatus = 'available' | 'degraded' | 'unavailable' | 'not-used';

export interface QueryExecutionDiagnostics {
  budget?: QueryBudgetSnapshot;
  capabilityHealth?: QueryCapabilityHealth;
  freshness?: QueryFreshnessState;
  evidence?: EvidenceDiagnosticRecord[];
  truncated?: boolean;
  truncatedReasons?: string[];
  degradedReasons?: string[];
  timing?: Record<string, number>;
  cacheHit?: boolean;
  cacheStatus?: 'hit' | 'miss' | 'stale' | 'expired';
  cacheAgeMs?: number;
  cacheEvictedEntries?: number;
  tokenCost?: QueryTokenCostSnapshot;
}
