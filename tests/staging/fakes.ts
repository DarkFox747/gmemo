/**
 * Test helpers for the staging write path.
 *
 * Provides:
 *  - FakeStagingSession / FakeStagingItem — seed types for preloading state.
 *  - InMemoryStagingRepository — seedable, deterministic fake of StagingRepository,
 *    mirroring tests/memory/fakes.ts.
 *
 * Behaviour contract:
 *  - findOrCreateOpenSession is idempotent per (project, repo, branch) key.
 *  - insertStagingItem deduplicates on (sessionId, contentHash): returns the
 *    pre-existing id + deduped:true on a second call with the same hash.
 *  - listStagingItems is tenant-scoped (project+repo+branch), newest first.
 *  - discardStagingItem is tenant-scoped; returns false when the item is absent
 *    or belongs to a different session (opaque — no enumeration).
 *
 * Generated IDs are deterministic:
 *  - Sessions: 'test-session-0001', 'test-session-0002', …
 *  - Items:    '00000000-0000-0000-0000-000000000001', …
 *
 * Public property `insertedItemCount` counts successful (non-dedup) inserts so
 * tests can assert that nothing was persisted when the secret-scan fires.
 */

import type {
  StagingRepository,
  StagingItemRow,
  InsertStagingItemParams,
} from '../../src/db/stagingRepository.js';
import type { TenantContext } from '../../src/mcp/context.js';
import type { MemoryType } from '../../src/contracts/memory.js';

// ---------------------------------------------------------------------------
// Seed data shapes
// ---------------------------------------------------------------------------

/** Seed record for a staging session. One open session per (project, repo, branch). */
export interface FakeStagingSession {
  /** Opaque session id — any unique string. */
  id: string;
  projectId: string;
  repoId: string;
  branch: string;
}

/**
 * Seed record for a staging item.
 * Must reference a seeded session by `sessionId`.
 * Mirrors InsertStagingItemParams + StagingItemRow output fields.
 */
export interface FakeStagingItem {
  /** Pre-assigned item id — must be unique within the fake instance. */
  id: string;
  sessionId: string;
  op: StagingItemRow['op'];
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields?: Record<string, unknown>;
  contentHash: string;
  targetMemoryId?: string | null;
  targetRevision?: number | null;
  judgeState?: StagingItemRow['judge_state'];
  authorIdentity?: string;
  /** Defaults to 2025-01-01T00:00:00Z when omitted. */
  createdAt?: Date;
}

// ---------------------------------------------------------------------------
// InMemoryStagingRepository
// ---------------------------------------------------------------------------

const DEFAULT_CREATED_AT = new Date('2025-01-01T00:00:00Z');

export class InMemoryStagingRepository implements StagingRepository {
  /**
   * Count of items actually inserted (non-dedup path).
   * The dedup path — where `insertStagingItem` returns `{deduped:true}` — does
   * NOT increment this counter. Use it in assertions such as:
   *   expect(stagingRepo.insertedItemCount).toBe(0)  // nothing persisted
   */
  public insertedItemCount = 0;

  /** tenantKey ('projectId:repoId:branch') → session id */
  private readonly sessionsByKey = new Map<string, string>();

  /** itemId → { sessionId, data: StagingItemRow } */
  private readonly storedItems = new Map<string, { sessionId: string; data: StagingItemRow }>();

  private sessionCounter = 0;
  private itemCounter = 0;

  constructor(
    sessions: FakeStagingSession[] = [],
    items: FakeStagingItem[] = [],
  ) {
    for (const s of sessions) {
      this.sessionsByKey.set(
        this.tenantKey({ projectId: s.projectId, repoId: s.repoId, branch: s.branch }),
        s.id,
      );
    }

    for (const item of items) {
      const data: StagingItemRow = {
        id: item.id,
        op: item.op,
        type: item.type,
        title: item.title,
        summary: item.summary,
        body: item.body,
        fields: item.fields ?? {},
        content_hash: item.contentHash,
        target_memory_id: item.targetMemoryId ?? null,
        target_revision: item.targetRevision ?? null,
        judge_state: item.judgeState ?? 'pending',
        created_at: item.createdAt ?? DEFAULT_CREATED_AT,
        promoted_at: null,
        promoted_memory_id: null,
      };
      this.storedItems.set(item.id, { sessionId: item.sessionId, data });
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private tenantKey(tenant: TenantContext): string {
    return `${tenant.projectId}:${tenant.repoId}:${tenant.branch}`;
  }

  private nextSessionId(): string {
    this.sessionCounter++;
    return `test-session-${String(this.sessionCounter).padStart(4, '0')}`;
  }

  private nextItemId(): string {
    this.itemCounter++;
    return `00000000-0000-0000-0000-${String(this.itemCounter).padStart(12, '0')}`;
  }

  // -------------------------------------------------------------------------
  // StagingRepository
  // -------------------------------------------------------------------------

  async findOrCreateOpenSession(tenant: TenantContext, _openedBy: string): Promise<string> {
    const key = this.tenantKey(tenant);
    const existing = this.sessionsByKey.get(key);
    if (existing !== undefined) return existing;

    const id = this.nextSessionId();
    this.sessionsByKey.set(key, id);
    return id;
  }

  async insertStagingItem(
    sessionId: string,
    p: InsertStagingItemParams,
  ): Promise<{ id: string; judgeState: StagingItemRow['judge_state']; deduped: boolean }> {
    // Dedup check: (sessionId, contentHash) uniqueness mirrors DB UNIQUE constraint.
    for (const entry of this.storedItems.values()) {
      if (entry.sessionId === sessionId && entry.data.content_hash === p.contentHash) {
        return { id: entry.data.id, judgeState: entry.data.judge_state, deduped: true };
      }
    }

    const id = this.nextItemId();
    const data: StagingItemRow = {
      id,
      op: p.op,
      type: p.type,
      title: p.title,
      summary: p.summary,
      body: p.body,
      fields: p.fields,
      content_hash: p.contentHash,
      target_memory_id: p.targetMemoryId,
      target_revision: p.targetRevision,
      judge_state: p.judgeState,
      created_at: new Date(),
      promoted_at: null,
      promoted_memory_id: null,
    };
    this.storedItems.set(id, { sessionId, data });
    this.insertedItemCount++;
    return { id, judgeState: data.judge_state, deduped: false };
  }

  async listStagingItems(tenant: TenantContext): Promise<StagingItemRow[]> {
    const key = this.tenantKey(tenant);
    const sessionId = this.sessionsByKey.get(key);
    if (sessionId === undefined) return [];

    return Array.from(this.storedItems.values())
      .filter((entry) => entry.sessionId === sessionId)
      .sort((a, b) => b.data.created_at.getTime() - a.data.created_at.getTime())
      .map((entry) => entry.data);
  }

  async discardStagingItem(tenant: TenantContext, itemId: string): Promise<boolean> {
    const key = this.tenantKey(tenant);
    const sessionId = this.sessionsByKey.get(key);
    if (sessionId === undefined) return false;

    const entry = this.storedItems.get(itemId);
    if (entry === undefined || entry.sessionId !== sessionId) return false;

    this.storedItems.delete(itemId);
    return true;
  }
}
