/**
 * T245: Row → contract mapper unit tests.
 *
 * Tests src/mcp/memoryMapper.ts::toMemoryRecord in isolation — no DB, no handler.
 *
 * Field mapping verified (design §Row→MemoryRecord):
 *  handle  — encodeHandle(row.id, row.current_revision); deterministic round-trip.
 *  type    — enum passthrough.
 *  title   — string passthrough.
 *  summary — string passthrough.
 *  body    — string passthrough.
 *  fields  — jsonb passthrough (Record<string,unknown>).
 *  date    — row.updated_at.toISOString() (NOT created_at, contract §4 rationale).
 *  origin  — { branch: origin_branch ?? '', pr: origin_pr ?? null }.
 *  source  — hardcoded 'main' (D1: staging deferred).
 *  stale   — opts?.stale; set only when explicitly passed (get_context).
 */

import { describe, it, expect } from 'vitest';
import { toMemoryRecord } from '../../src/mcp/memoryMapper.js';
import { encodeHandle, decodeHandle } from '../../src/mcp/handle.js';
import type { MemoryRow } from '../../src/db/memoryRepository.js';

// ---------------------------------------------------------------------------
// Shared test row
// ---------------------------------------------------------------------------

const MEMORY_ID = '11111111-1111-1111-1111-111111111111';
const UPDATED_AT = new Date('2025-06-15T12:30:00.000Z');

const FULL_ROW: MemoryRow = {
  id: MEMORY_ID,
  type: 'decision',
  title: 'Use repository pattern',
  summary: 'Repository pattern for data access consistency',
  body: 'Detailed rationale for choosing the repository pattern.',
  fields: { rationale: 'consistency', status: 'accepted' },
  origin_branch: 'feat/memory-layer',
  origin_pr: 42,
  current_revision: 3,
  updated_at: UPDATED_AT,
};

// ---------------------------------------------------------------------------
// source is always 'main'
// ---------------------------------------------------------------------------

describe('toMemoryRecord — source field', () => {
  it('always sets source to "main" (D1: staging is deferred)', () => {
    const record = toMemoryRecord(FULL_ROW);
    expect(record.source).toBe('main');
  });

  it('source is "main" even when opts.stale is explicitly true', () => {
    const record = toMemoryRecord(FULL_ROW, { stale: true });
    expect(record.source).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// handle encoding
// ---------------------------------------------------------------------------

describe('toMemoryRecord — handle', () => {
  it('encodes handle as encodeHandle(id, current_revision)', () => {
    const record = toMemoryRecord(FULL_ROW);
    const expected = encodeHandle(MEMORY_ID, 3);
    expect(record.handle).toBe(expected);
  });

  it('encoded handle decodes back to the correct (id, revision) pair', () => {
    const record = toMemoryRecord(FULL_ROW);
    const decoded = decodeHandle(record.handle);
    expect(decoded.memoryId).toBe(MEMORY_ID);
    expect(decoded.revisionNo).toBe(3);
  });

  it('handle changes when current_revision changes', () => {
    const row1 = { ...FULL_ROW, current_revision: 1 };
    const row2 = { ...FULL_ROW, current_revision: 2 };
    expect(toMemoryRecord(row1).handle).not.toBe(toMemoryRecord(row2).handle);
  });
});

// ---------------------------------------------------------------------------
// date from updated_at
// ---------------------------------------------------------------------------

describe('toMemoryRecord — date', () => {
  it('sets date to row.updated_at.toISOString()', () => {
    const record = toMemoryRecord(FULL_ROW);
    expect(record.date).toBe(UPDATED_AT.toISOString());
  });

  it('date reflects the updated_at value, not created_at or reviewed_at', () => {
    const differentDate = new Date('2024-01-01T00:00:00.000Z');
    const row = { ...FULL_ROW, updated_at: differentDate };
    expect(toMemoryRecord(row).date).toBe(differentDate.toISOString());
  });
});

// ---------------------------------------------------------------------------
// origin: null collapses to empty string / null preserved
// ---------------------------------------------------------------------------

describe('toMemoryRecord — origin', () => {
  it('passes through branch and pr when both are set', () => {
    const record = toMemoryRecord(FULL_ROW);
    expect(record.origin.branch).toBe('feat/memory-layer');
    expect(record.origin.pr).toBe(42);
  });

  it('converts null origin_branch to empty string (manual_ui provenance)', () => {
    const row = { ...FULL_ROW, origin_branch: null };
    const record = toMemoryRecord(row);
    expect(record.origin.branch).toBe('');
  });

  it('keeps null origin_pr as null', () => {
    const row = { ...FULL_ROW, origin_pr: null };
    const record = toMemoryRecord(row);
    expect(record.origin.pr).toBeNull();
  });

  it('returns { branch: "", pr: null } when both are null', () => {
    const row = { ...FULL_ROW, origin_branch: null, origin_pr: null };
    const record = toMemoryRecord(row);
    expect(record.origin).toEqual({ branch: '', pr: null });
  });
});

// ---------------------------------------------------------------------------
// fields passthrough
// ---------------------------------------------------------------------------

describe('toMemoryRecord — fields', () => {
  it('passes fields object through unchanged', () => {
    const record = toMemoryRecord(FULL_ROW);
    expect(record.fields).toEqual({ rationale: 'consistency', status: 'accepted' });
  });

  it('passes empty fields object through', () => {
    const row = { ...FULL_ROW, fields: {} };
    const record = toMemoryRecord(row);
    expect(record.fields).toEqual({});
  });

  it('fields is a plain object (not null, not array)', () => {
    const record = toMemoryRecord(FULL_ROW);
    expect(typeof record.fields).toBe('object');
    expect(record.fields).not.toBeNull();
    expect(Array.isArray(record.fields)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stale field (opts?.stale)
// ---------------------------------------------------------------------------

describe('toMemoryRecord — stale', () => {
  it('omits stale when opts is not provided (recall / get_memory usage)', () => {
    const record = toMemoryRecord(FULL_ROW);
    expect(record.stale).toBeUndefined();
  });

  it('sets stale: true when opts.stale is true (get_context TTL-expired record)', () => {
    const record = toMemoryRecord(FULL_ROW, { stale: true });
    expect(record.stale).toBe(true);
  });

  it('sets stale: false when opts.stale is false', () => {
    const record = toMemoryRecord(FULL_ROW, { stale: false });
    expect(record.stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// type passthrough
// ---------------------------------------------------------------------------

describe('toMemoryRecord — type passthrough', () => {
  const types: Array<MemoryRow['type']> = [
    'decision',
    'constraint',
    'gotcha',
    'pattern',
    'integration_note',
    'domain_rule',
    'outcome',
  ];

  for (const type of types) {
    it(`passes through type "${type}"`, () => {
      const row = { ...FULL_ROW, type };
      expect(toMemoryRecord(row).type).toBe(type);
    });
  }
});

// ---------------------------------------------------------------------------
// title / summary / body passthrough
// ---------------------------------------------------------------------------

describe('toMemoryRecord — string fields passthrough', () => {
  it('passes title, summary, and body through unchanged', () => {
    const record = toMemoryRecord(FULL_ROW);
    expect(record.title).toBe(FULL_ROW.title);
    expect(record.summary).toBe(FULL_ROW.summary);
    expect(record.body).toBe(FULL_ROW.body);
  });
});
