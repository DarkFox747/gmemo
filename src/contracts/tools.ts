// Request/response types for the MCP read and write tools.
// Mirrors gmemo_facade_contract_v1.md §2–§5 exactly.
// Import these types in tool handlers and zod schemas to keep shapes in sync.

import type { MemoryRecord, MemoryRelation, MemoryType } from './memory.js';

// --- recall ---

export interface RecallRequest {
  query: string; // required
  scope?: 'repo' | 'project'; // default 'project' (contract §2)
  types?: MemoryType[]; // optional filter; default all
  limit?: number; // default 5, max 8 (contract §2 / §8)
  cursor?: string; // opaque offset cursor over the fused RRF list, from a prior recall response
}

export interface RecallResponse {
  results: MemoryRecord[]; // whole records (contract §2/§8)
  total_matches: number;
  cursor: string | null; // null when no further page
}

// --- get_memory ---

export interface GetMemoryRequest {
  handle: string;
}

export interface GetMemoryResponse {
  memory: MemoryRecord;
  relations: MemoryRelation[]; // supersedes / conflicts_with / duplicate
  references: string[]; // opaque handles referenced by this record
}

// --- get_context ---

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GetContextRequest {} // no params — contract §2: get_context takes no parameters

export interface GetContextResponse {
  records: MemoryRecord[]; // whole records, constraints/domain_rules first
}

// --- remember ---

export interface RememberRequest {
  op: 'add' | 'amend' | 'supersede' | 'deprecate';
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields?: Record<string, unknown>;
  target_handle?: string;
}

export interface RememberResponse {
  id: string;
  state: 'pending' | 'uncertain';
}

// Internal handler return (superset); wrapper projects to RememberResponse for the agent.
export interface RememberResult extends RememberResponse {
  sessionId: string;
  contentHash: string;
}

// --- list_staged ---

export interface StagedItemView {
  id: string;
  op: RememberRequest['op'];
  type: MemoryType;
  title: string;
  summary: string;
  state: string;
  date: string;
}

export interface ListStagedResponse {
  items: StagedItemView[];
}

// --- discard_staged ---

export interface DiscardStagedRequest {
  item_id: string;
}

export interface DiscardStagedResponse {
  discarded: true;
}
