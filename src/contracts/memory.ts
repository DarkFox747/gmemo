// Shared memory record types — mirrors gmemo_facade_contract_v1.md §1 exactly.
// These types are the single source of truth for every tool's response shape.
// Do NOT add fields not present in the contract (no status, no internal IDs).

export type MemoryType =
  | 'decision'
  | 'constraint'
  | 'gotcha'
  | 'pattern'
  | 'integration_note'
  | 'domain_rule'
  | 'outcome';

export type MemorySource = 'main' | 'staged';

export interface MemoryOrigin {
  branch: string; // literal originating branch name (contract §1)
  pr: number | null; // PR number, or null if none yet
}

export interface MemoryRecord {
  handle: string; // opaque, per-recall, bound to (memory_id, revision)
  type: MemoryType;
  title: string; // <= 120 chars
  summary: string; // <= 200 chars — the "what" in one line
  body: string; // markdown, <= 2000 chars — rationale
  fields: Record<string, unknown>; // per-type fields (contract §1)
  date: string; // ISO-8601 (promotion date)
  origin: MemoryOrigin;
  source: MemorySource; // "main" | "staged"
  stale?: boolean; // set by get_context for TTL-expired-but-active
}

// Relation edge types sourced from data_model.memory.memory_relation.
export type MemoryRelationType = 'supersedes' | 'conflicts_with' | 'duplicate';

export interface MemoryRelation {
  type: MemoryRelationType;
  handle: string;
}
