/**
 * PromoteService — orchestrates the per-session promotion state machine.
 *
 * Algorithm (sequential; fail-closed; idempotent):
 *   1. fetchPromotableItems (promoted_at IS NULL — already-applied items excluded).
 *      Empty → return no_op immediately.
 *   2. For each item (in order):
 *      a. Skip if judge_state === 'rejected' (already quarantined on a prior run).
 *      b. Determine verdict — reuse persisted state ('accepted'/'uncertain') or judge fresh:
 *           sanitize (assertNoSecrets) → quarantine(secret_detected, redact=true) + continue
 *           judge.evaluate → recordVerdict.
 *         A caught judge error is NEVER mapped to 'accepted' (BedrockJudge is already
 *         fail-closed to 'uncertain'; the service adds no extra mapping).
 *      c. Route on verdict:
 *           accepted  → applyAccepted → applied / stale→quarantine / dup→quarantine / already
 *           rejected  → quarantineItem
 *           uncertain → leave un-applied (verdict persisted)
 *   3. Terminal status: all applied → promoted; none applied + none uncertain → rejected;
 *      otherwise → partially_promoted. finalizeSession.
 *   4. recordPromote audit.
 *   5. Return PromoteOutcome.
 *
 * Idempotency: step 1's promoted_at IS NULL filter + applyAccepted's FOR UPDATE +
 * promoted_at IS NULL guard mean a re-run applies nothing already applied and never
 * double-writes memory or revision rows.
 */

import type { TenantContext, ActorIdentity, AuditLogger, RequestContext } from '../mcp/context.js';
import type {
  PromotionRepository,
  PromotionItemRow,
  ApplyContext,
  Verdict,
} from '../db/promotionRepository.js';
import type { Judge } from '../judge/judge.js';
import type { Embedder } from '../embedder/embedder.js';
import { assertNoSecrets } from '../security/secretScan.js';
import { logger } from '../observability/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromoteMeta {
  tenant: TenantContext;
  actor: ActorIdentity;
  originBranch: string;
  originPr: number | null;
  mergeSha: string | null;
}

export interface PromoteOutcome {
  status: 'promoted' | 'rejected' | 'partially_promoted' | 'no_op';
  applied: number;
  deduped: number;
  quarantined: number;
  uncertain: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Narrow seam over PromoteService used by AppServices and test fakes.
 * Mirrors the OidcVerifier / Authorizer seam pattern.
 */
export interface PromoteServiceLike {
  promote(sessionId: string, meta: PromoteMeta): Promise<PromoteOutcome>;
}

export class PromoteService implements PromoteServiceLike {
  constructor(
    private readonly deps: {
      promotionRepository: PromotionRepository;
      judge: Judge;
      auditLogger: AuditLogger;
      embedder: Embedder;
    },
  ) {}

  async promote(sessionId: string, meta: PromoteMeta): Promise<PromoteOutcome> {
    const { promotionRepository, judge, auditLogger } = this.deps;

    // Step 1: Fetch all promotable items (promoted_at IS NULL).
    // Pass projectId so the repository JOIN re-asserts tenant ownership (L3 fix).
    const items: PromotionItemRow[] = await promotionRepository.fetchPromotableItems(
      sessionId,
      meta.tenant.projectId,
    );
    if (items.length === 0) {
      // Nothing to do — idempotent re-run after a completed promote.
      return { status: 'no_op', applied: 0, deduped: 0, quarantined: 0, uncertain: 0 };
    }

    // Step 2: Build per-session apply context.
    const ctx: ApplyContext = {
      projectId: meta.tenant.projectId,
      repoId: meta.tenant.repoId,
      originBranch: meta.originBranch,
      originPr: meta.originPr,
      sessionId,
    };

    let applied = 0;
    let deduped = 0;
    let quarantined = 0;
    let uncertain = 0;

    // Step 3: Process each item sequentially (Decision 1 — per-item txn granularity).
    for (const item of items) {
      // 3a: Skip items already quarantined on a prior run (no duplicate quarantine).
      if (item.judge_state === 'rejected') {
        continue;
      }

      // 3b: Determine verdict — reuse persisted state or judge fresh.
      let verdict: Verdict;

      if (item.judge_state === 'accepted' || item.judge_state === 'uncertain') {
        // Verdict already persisted from a prior partial run — reuse it.
        verdict = item.judge_state as Verdict;
      } else {
        // item.judge_state === 'pending' — sanitize then judge.

        // Sanitize: assertNoSecrets is fail-closed; any finding → quarantine + skip.
        // fields is included (mirrors remember.ts step 4) — promotion is the last
        // barrier before authoritative memory; must be at least as thorough (M1 fix).
        try {
          assertNoSecrets(item.title, item.summary, item.body, JSON.stringify(item.fields ?? {}));
        } catch {
          // Secret found — quarantine with redaction and move to next item.
          await promotionRepository.quarantineItem(item, ctx, 'secret_detected', true);
          quarantined++;
          continue;
        }

        // Judge (BedrockJudge is already fail-closed → uncertain on any error;
        // the service NEVER maps a caught judge error to 'accepted').
        verdict = await judge.evaluate({
          op: item.op,
          type: item.type,
          title: item.title,
          summary: item.summary,
          body: item.body,
          fields: item.fields,
        });

        // Persist verdict for non-rejected items so re-runs can reuse it without
        // re-judging. For rejected: quarantineItem's in-txn MARK_QUARANTINED_SQL
        // sets judge_state='rejected' atomically with the quarantine insert, so a
        // pre-quarantine recordVerdict would leave state inconsistent if quarantine
        // then fails (L2 fix — do NOT add recordVerdict back for the rejected path).
        if (verdict !== 'rejected') {
          await promotionRepository.recordVerdict(item.id, verdict, null);
        }
      }

      // 3c: Route on verdict.
      if (verdict === 'accepted') {
        // Compute embedding fail-soft before apply (Decision 8).
        // deprecate has no content change — skip embed and pass null.
        let embedding: number[] | null = null;
        if (item.op !== 'deprecate') {
          try {
            embedding = await this.deps.embedder.embed(
              `${item.title}\n${item.summary}\n${item.body}`,
            );
          } catch {
            logger.warn(
              `[promote] embedding failed for item ${item.id} — writing NULL (fail-soft)`,
            );
            embedding = null;
          }
        }
        const r = await promotionRepository.applyAccepted(item, ctx, embedding);
        switch (r.status) {
          case 'applied':
            applied++;
            if (r.deduped) deduped++;
            break;
          case 'stale':
            await promotionRepository.quarantineItem(item, ctx, 'stale_target', false);
            quarantined++;
            break;
          case 'duplicate':
            await promotionRepository.quarantineItem(item, ctx, 'duplicate_content', false);
            quarantined++;
            break;
          case 'already':
            // Idempotent re-run for an already-applied item — count as applied.
            applied++;
            break;
        }
      } else if (verdict === 'rejected') {
        await promotionRepository.quarantineItem(
          item,
          ctx,
          item.judge_reason ?? 'judge_rejected',
          false,
        );
        quarantined++;
      } else {
        // uncertain — leave un-applied; verdict was already persisted above.
        uncertain++;
      }
    }

    // Step 4: Determine terminal status and finalize the session.
    const total = items.length;
    let terminalStatus: 'promoted' | 'rejected' | 'partially_promoted';
    if (applied === total) {
      terminalStatus = 'promoted';
    } else if (applied === 0 && uncertain === 0) {
      terminalStatus = 'rejected';
    } else {
      terminalStatus = 'partially_promoted';
    }
    await promotionRepository.finalizeSession(sessionId, terminalStatus);

    // Step 5: Audit log (actorKind 'ci', action 'promote').
    const reqCtx: RequestContext = { tenant: meta.tenant, actor: meta.actor };
    await auditLogger.recordPromote(reqCtx, {
      sessionId,
      applied,
      quarantined,
      uncertain,
      prNumber: meta.originPr,
      mergeSha: meta.mergeSha,
    });

    // Step 6: Return outcome.
    return { status: terminalStatus, applied, deduped, quarantined, uncertain };
  }
}
