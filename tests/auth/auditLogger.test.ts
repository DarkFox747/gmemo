/**
 * T165: RdsAuditLogger — audit log unit tests.
 *
 * Uses InMemoryAuthRepository to capture access_log inserts without a real DB.
 * Asserts that:
 *  - exactly one row is written per recordRead call
 *  - actor_kind = 'user' (human read path)
 *  - action = 'read'
 *  - project_id matches the tenant
 *  - actor_identity matches the actor's actorId (raw JWT sub)
 *  - query_hash is present for recall and get_memory (and is the SHA-256 of the query)
 *  - query_hash is absent (undefined) for get_context (no query)
 *  - raw query text NEVER appears anywhere in the log entry
 *
 * recordWrite tests cover:
 *  - remember: sessionId, contentHash, tool='remember' in detail
 *  - discard_staged: no sessionId, no queryHash, tool='discard_staged' in detail
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RdsAuditLogger } from '../../src/auth/auditLogger.js';
import { InMemoryAuthRepository } from './fakes.js';
import { sha256Hex } from '../../src/security/hash.js';
import type { RequestContext, ToolName } from '../../src/mcp/context.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-uuid-001';
const REPO_ID = 'repo-uuid-001';
const ACTOR_ID = 'user-sub-abc';

const CTX: RequestContext = {
  tenant: { projectId: PROJECT_ID, repoId: REPO_ID, branch: 'main' },
  actor: { actorId: ACTOR_ID, roles: ['viewer'] },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RdsAuditLogger — access_log writes', () => {
  let repo: InMemoryAuthRepository;
  let logger: RdsAuditLogger;

  beforeEach(() => {
    repo = new InMemoryAuthRepository();
    logger = new RdsAuditLogger(repo);
  });

  it('writes exactly one access_log row per recordRead call', async () => {
    const queryHash = sha256Hex('architecture decisions');
    await logger.recordRead(CTX, 'recall', queryHash);

    expect(repo.accessLogEntries).toHaveLength(1);
  });

  it('sets actor_kind to "user"', async () => {
    await logger.recordRead(CTX, 'recall', sha256Hex('test query'));

    expect(repo.accessLogEntries[0].actorKind).toBe('user');
  });

  it('sets action to "read"', async () => {
    await logger.recordRead(CTX, 'recall', sha256Hex('test query'));

    expect(repo.accessLogEntries[0].action).toBe('read');
  });

  it('sets project_id from the tenant context', async () => {
    await logger.recordRead(CTX, 'recall', sha256Hex('test query'));

    expect(repo.accessLogEntries[0].projectId).toBe(PROJECT_ID);
  });

  it('sets actor_identity to the actorId (raw JWT sub)', async () => {
    await logger.recordRead(CTX, 'recall', sha256Hex('test query'));

    expect(repo.accessLogEntries[0].actorIdentity).toBe(ACTOR_ID);
  });

  it('stores the provided query_hash for recall', async () => {
    const rawQuery = 'how should we handle auth failures';
    const queryHash = sha256Hex(rawQuery.trim().toLowerCase());
    await logger.recordRead(CTX, 'recall', queryHash);

    expect(repo.accessLogEntries[0].queryHash).toBe(queryHash);
  });

  it('raw query text is NEVER present in the access_log entry', async () => {
    const rawQuery = 'super secret architecture decision query';
    const queryHash = sha256Hex(rawQuery.trim().toLowerCase());
    await logger.recordRead(CTX, 'recall', queryHash);

    const entry = repo.accessLogEntries[0];
    const serialized = JSON.stringify(entry);

    // The hash itself is present (that is expected)
    expect(entry.queryHash).toBe(queryHash);
    // The raw text must NOT appear anywhere in the entry
    expect(serialized).not.toContain(rawQuery);
  });

  it('stores the provided query_hash for get_memory', async () => {
    const handle = 'mem-uuid-0001-rev2';
    const queryHash = sha256Hex(handle);
    await logger.recordRead(CTX, 'get_memory', queryHash);

    expect(repo.accessLogEntries[0].queryHash).toBe(queryHash);
  });

  it('writes no query_hash for get_context (no query input)', async () => {
    await logger.recordRead(CTX, 'get_context');

    const entry = repo.accessLogEntries[0];
    // query_hash should be absent/undefined when no hash is supplied
    expect(entry.queryHash == null).toBe(true);
  });

  it('accumulates multiple entries when called multiple times', async () => {
    const tools: ToolName[] = ['recall', 'get_memory', 'get_context'];
    for (const tool of tools) {
      const hash = tool !== 'get_context' ? sha256Hex(`query-for-${tool}`) : undefined;
      await logger.recordRead(CTX, tool, hash);
    }

    expect(repo.accessLogEntries).toHaveLength(3);
    expect(repo.accessLogEntries[0].detail).toMatchObject({ tool: 'recall' });
    expect(repo.accessLogEntries[1].detail).toMatchObject({ tool: 'get_memory' });
    expect(repo.accessLogEntries[2].detail).toMatchObject({ tool: 'get_context' });
  });
});

// ---------------------------------------------------------------------------
// recordWrite (remember) — staging write audit
// ---------------------------------------------------------------------------

describe('RdsAuditLogger — recordWrite (remember)', () => {
  let repo: InMemoryAuthRepository;
  let logger: RdsAuditLogger;

  const SESSION_ID = '01JXYZ0000ABCDEFGHMNPQRS';
  const ITEM_ID = 'item-uuid-aabbccdd';
  const CONTENT_HASH = sha256Hex('canonical-payload-for-this-item');

  beforeEach(() => {
    repo = new InMemoryAuthRepository();
    logger = new RdsAuditLogger(repo);
  });

  it('inserts exactly one access_log row', async () => {
    await logger.recordWrite(CTX, {
      tool: 'remember',
      sessionId: SESSION_ID,
      itemId: ITEM_ID,
      contentHash: CONTENT_HASH,
    });

    expect(repo.accessLogEntries).toHaveLength(1);
  });

  it('sets action to "stage"', async () => {
    await logger.recordWrite(CTX, {
      tool: 'remember',
      sessionId: SESSION_ID,
      itemId: ITEM_ID,
      contentHash: CONTENT_HASH,
    });

    expect(repo.accessLogEntries[0].action).toBe('stage');
  });

  it('sets actor_kind to "user"', async () => {
    await logger.recordWrite(CTX, {
      tool: 'remember',
      sessionId: SESSION_ID,
      itemId: ITEM_ID,
      contentHash: CONTENT_HASH,
    });

    expect(repo.accessLogEntries[0].actorKind).toBe('user');
  });

  it('sets session_id to the passed sessionId (not null/undefined)', async () => {
    await logger.recordWrite(CTX, {
      tool: 'remember',
      sessionId: SESSION_ID,
      itemId: ITEM_ID,
      contentHash: CONTENT_HASH,
    });

    expect(repo.accessLogEntries[0].sessionId).toBe(SESSION_ID);
  });

  it('sets query_hash equal to the passed contentHash', async () => {
    await logger.recordWrite(CTX, {
      tool: 'remember',
      sessionId: SESSION_ID,
      itemId: ITEM_ID,
      contentHash: CONTENT_HASH,
    });

    expect(repo.accessLogEntries[0].queryHash).toBe(CONTENT_HASH);
  });

  it('sets detail with tool:"remember", repoId, branch, and itemId', async () => {
    await logger.recordWrite(CTX, {
      tool: 'remember',
      sessionId: SESSION_ID,
      itemId: ITEM_ID,
      contentHash: CONTENT_HASH,
    });

    expect(repo.accessLogEntries[0].detail).toMatchObject({
      tool: 'remember',
      repoId: REPO_ID,
      branch: 'main',
      itemId: ITEM_ID,
    });
  });
});

// ---------------------------------------------------------------------------
// recordWrite (discard_staged) — discard audit shape
// ---------------------------------------------------------------------------

describe('RdsAuditLogger — recordWrite (discard_staged)', () => {
  let repo: InMemoryAuthRepository;
  let logger: RdsAuditLogger;

  const ITEM_ID = 'item-uuid-discard-001';

  beforeEach(() => {
    repo = new InMemoryAuthRepository();
    logger = new RdsAuditLogger(repo);
  });

  it('inserts exactly one access_log row for a discard', async () => {
    await logger.recordWrite(CTX, { tool: 'discard_staged', itemId: ITEM_ID });

    expect(repo.accessLogEntries).toHaveLength(1);
  });

  it('sets action to "stage" (reuses the existing enum value)', async () => {
    await logger.recordWrite(CTX, { tool: 'discard_staged', itemId: ITEM_ID });

    expect(repo.accessLogEntries[0].action).toBe('stage');
  });

  it('sets detail.tool to "discard_staged"', async () => {
    await logger.recordWrite(CTX, { tool: 'discard_staged', itemId: ITEM_ID });

    expect(repo.accessLogEntries[0].detail).toMatchObject({
      tool: 'discard_staged',
      itemId: ITEM_ID,
    });
  });

  it('sessionId is absent/undefined (no open-session context for a discard)', async () => {
    await logger.recordWrite(CTX, { tool: 'discard_staged', itemId: ITEM_ID });

    expect(repo.accessLogEntries[0].sessionId == null).toBe(true);
  });

  it('query_hash is absent/undefined (no content_hash for a discard)', async () => {
    await logger.recordWrite(CTX, { tool: 'discard_staged', itemId: ITEM_ID });

    expect(repo.accessLogEntries[0].queryHash == null).toBe(true);
  });
});
