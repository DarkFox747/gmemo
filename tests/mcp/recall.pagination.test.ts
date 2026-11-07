/**
 * Transport-level cursor-forwarding regression test for the recall tool (REQ-07).
 *
 * Uses the SDK Client + InMemoryTransport (no real network) to exercise the
 * full registered-tool call path — including the argument destructure in
 * src/mcp/tools/index.ts — to verify that the `cursor` argument is forwarded
 * end-to-end to the repository and produces a distinct page 2.
 *
 * This test FAILS against the pre-fix code (FIX-CURSOR) where `cursor` was
 * absent from the destructure, causing every call to start from page 1.
 *
 * Seed layout:
 *   5 records, all in projectId='stub-project' (matching STUB_TENANT).
 *   Query 'xyzxyz' matches no record text → all ranks are 0.
 *   Sort order is therefore purely by id DESC:
 *     eeeeeeee > dddddddd > cccccccc > bbbbbbbb > aaaaaaaa
 *
 *   limit=2:
 *     page 1 (no cursor) → [eeee…, dddd…]  + nextCursor
 *     page 2 (with cursor) → [cccc…, bbbb…]  (distinct from page 1)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { makeStubAuthServices } from '../auth/fakes.js';
import { InMemoryMemoryRepository, type FakeMemory } from '../memory/fakes.js';
import type { MemoryRepository } from '../../src/db/memoryRepository.js';

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

/** Matches the projectId returned by the stub TenantResolver (STUB_TENANT). */
const SEED_PROJECT = 'stub-project';

const SEEDS: FakeMemory[] = [
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    projectId: SEED_PROJECT,
    type: 'constraint',
    title: 'Record Alpha',
    summary: 'Alpha summary',
    body: 'Alpha body.',
    currentRevision: 1,
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    status: 'active',
  },
  {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    projectId: SEED_PROJECT,
    type: 'gotcha',
    title: 'Record Bravo',
    summary: 'Bravo summary',
    body: 'Bravo body.',
    currentRevision: 1,
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    status: 'active',
  },
  {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    projectId: SEED_PROJECT,
    type: 'decision',
    title: 'Record Charlie',
    summary: 'Charlie summary',
    body: 'Charlie body.',
    currentRevision: 1,
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    status: 'active',
  },
  {
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    projectId: SEED_PROJECT,
    type: 'pattern',
    title: 'Record Delta',
    summary: 'Delta summary',
    body: 'Delta body.',
    currentRevision: 1,
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    status: 'active',
  },
  {
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    projectId: SEED_PROJECT,
    type: 'outcome',
    title: 'Record Echo',
    summary: 'Echo summary',
    body: 'Echo body.',
    currentRevision: 1,
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    status: 'active',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecallResponseJson {
  results: Array<{ handle: string }>;
  total_matches: number;
  cursor: string | null;
}

/** Builds a full Deps bag with the given repository, using stub auth services. */
function makeTestDeps(memoryRepository: MemoryRepository) {
  const base = makeStubAuthServices();
  return {
    ...base,
    memoryRepository,
    resolutionInput: {
      authorization: undefined,
      gitRemote: undefined,
      branch: undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recall tool — transport-level cursor forwarding (REQ-07)', () => {
  let client: Client | undefined;

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => {
        // best-effort cleanup
      });
      client = undefined;
    }
  });

  it('page 2 (via cursor) is non-empty and does not overlap with page 1', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const memoryRepository = new InMemoryMemoryRepository(SEEDS);
    const mcpServer = createMcpServer(makeTestDeps(memoryRepository));
    await mcpServer.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    // --- Page 1: no cursor, limit=2 ---
    const page1Result = await client.callTool({
      name: 'recall',
      arguments: { query: 'xyzxyz', scope: 'project', limit: 2 },
    });

    expect(page1Result.isError).toBeFalsy();

    const page1Text = (page1Result.content[0] as { type: string; text: string }).text;
    const page1 = JSON.parse(page1Text) as RecallResponseJson;

    // Page 1 must return exactly the requested limit and carry a cursor.
    expect(page1.results).toHaveLength(2);
    expect(page1.cursor).not.toBeNull();

    const page1Handles = new Set(page1.results.map((r) => r.handle));

    // --- Page 2: use cursor returned from page 1 ---
    const page2Result = await client.callTool({
      name: 'recall',
      arguments: { query: 'xyzxyz', scope: 'project', limit: 2, cursor: page1.cursor },
    });

    expect(page2Result.isError).toBeFalsy();

    const page2Text = (page2Result.content[0] as { type: string; text: string }).text;
    const page2 = JSON.parse(page2Text) as RecallResponseJson;

    // Page 2 must be non-empty (there are 5 seeds, limit=2 → at least 2 on page 2).
    expect(page2.results.length).toBeGreaterThan(0);

    // No handle from page 2 should appear in page 1 — cursor advanced the window.
    for (const record of page2.results) {
      expect(page1Handles.has(record.handle)).toBe(false);
    }
  });
});
