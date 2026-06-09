export type AuditSeverity = 'LOW' | 'MEDIUM' | 'HIGH';
export type AuditStatus = 'open' | 'closed' | 'stale' | 'unknown';

export interface AuditResponse {
  summary: string;
  findings?: AuditFinding[];
  evidence?: AuditEvidence[];
  risks?: AuditRisk[];
  suggested_next_steps?: string[];
  residue?: AuditResidue[];
  coverage?: AuditCoverage[];
  drift?: AuditDrift[];
  flow?: AuditFlowStep[];
  items?: AuditRequirementItem[];
  doc_edits_suggested?: string[];
}

export interface AuditFinding {
  title?: string;
  pattern?: string;
  pattern_expression?: string;
  pattern_kind?: 'literal' | 'regex';
  severity: AuditSeverity;
  file: string;
  line: number;
  column?: number;
  line_hash?: string;
  detail: string;
  remediation?: string;
  status?: AuditStatus;
}

export interface AuditEvidence {
  file: string;
  line: number;
  column?: number;
  snippet?: string;
  why_it_matters?: string;
}

export interface AuditRisk {
  category: string;
  impact: string;
  severity: AuditSeverity;
}

export interface AuditResidue {
  domain: string;
  severity: AuditSeverity;
  hits: string[];
  classification: string;
}

export interface AuditCoverage {
  file: string;
  status: 'covered' | 'weakly_covered' | 'uncovered';
  gap: string;
}

export interface AuditDrift {
  topic: string;
  conflict: string[];
  suggested_resolution: string;
}

export interface AuditFlowStep {
  kind: string;
  file: string;
  line: number;
  detail?: string;
  confidence?: 'low' | 'medium' | 'high';
}

export interface AuditRequirementItem {
  id: string;
  status: 'implemented' | 'partial' | 'missing' | 'deferred' | 'blocked';
  confidence: 'low' | 'medium' | 'high';
  evidence?: string[];
  reason?: string;
}
