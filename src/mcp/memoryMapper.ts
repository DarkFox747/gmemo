/**
 * Pure row → contract mapper. No DB access; no side effects.
 *
 * All three read tool handlers share this function to build MemoryRecord
 * values from DB row projections:
 *  - recall        → toMemoryRecord(row)            (no stale)
 *  - get_memory    → toMemoryRecord(row)            (no stale)
 *  - get_context   → toMemoryRecord(row, { stale }) (stale set per row from SQL)
 *
 * Source is always 'main' (D1: staging tables are deferred; recall returns
 * main-branch records exclusively in this change).
 */

import type { MemoryRow } from '../db/memoryRepository.js';
import type { StagingItemRow } from '../db/stagingRepository.js';
import type { MemoryRecord } from '../contracts/memory.js';
import { encodeHandle } from './handle.js';

/**
 * Maps a DB MemoryRow to the MemoryRecord contract type.
 *
 * Field mapping:
 *  handle  — encodeHandle(row.id, row.current_revision); always the freshest revision.
 *  date    — row.updated_at ISO string; reflects last promotion/amend (D4 rationale).
 *  origin  — { branch: origin_branch ?? '', pr: origin_pr ?? null };
 *            null branch (manual_ui provenance) collapses to empty string per contract §1.
 *  source  — hardcoded 'main' (D1).
 *  stale   — opts?.stale; set only by get_context; undefined for recall/get_memory.
 */
/**
 * Maps a StagingItemRow to the MemoryRecord contract type for recall staging-mix.
 *
 * Field mapping:
 *  handle  — encodeHandle(item.id, 1); staged items have no revision history yet.
 *  date    — item.created_at ISO string; reflects when the draft was staged.
 *  origin  — { branch, pr: null }; PR is unknown until promotion.
 *  source  — hardcoded 'staged'; distinguishes drafts from authoritative main records.
 *  stale   — not set; staged items do not have a stale concept in this slice.
 */
export function toStagedRecord(item: StagingItemRow, branch: string): MemoryRecord {
  return {
    handle: encodeHandle(item.id, 1),
    type: item.type,
    title: item.title,
    summary: item.summary,
    body: item.body,
    fields: item.fields,
    date: item.created_at.toISOString(),
    origin: {
      branch,
      pr: null,
    },
    source: 'staged',
  };
}

export function toMemoryRecord(row: MemoryRow, opts?: { stale?: boolean }): MemoryRecord {
  return {
    handle: encodeHandle(row.id, row.current_revision),
    type: row.type,
    title: row.title,
    summary: row.summary,
    body: row.body,
    fields: row.fields,
    date: row.updated_at.toISOString(),
    origin: {
      branch: row.origin_branch ?? '',
      pr: row.origin_pr ?? null,
    },
    source: 'main',
    stale: opts?.stale,
  };
}
