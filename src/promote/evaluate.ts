/**
 * evaluateCandidate — what the pipeline thinks of one unit, with NO writes (C5).
 *
 *   sanitize (S1–S4) → blocked? stop (the judge is never called)
 *   → judge context (read) → judge → normalizeJudgeResult → routeDecision (R1–R8)
 *
 * Shared by PromoteService.processItem (which then performs the side effects)
 * and the direct-management preview, so a preview and its confirm run the same
 * code. The only repository capability is the findJudgeContext read, so the
 * type system forbids a write here.
 *
 * Never throws on a context or judge failure: both fail closed to `uncertain`.
 * Logging: the logId (item id or 'preview') and error names only — never content.
 */

import type { PromotionRepository } from '../db/promotionRepository.js';
import type { Judge, JudgeContextItem, JudgeResult } from '../judge/judge.js';
import { failClosed, normalizeJudgeResult } from '../judge/judge.js';
import { sanitizeItem } from './sanitize.js';
import type { SanitizeBlock, SanitizeResult } from './sanitize.js';
import { routeDecision } from './routing.js';
import type { RouteOutcome, RoutingConfig, RoutingDecision, RoutingItem } from './routing.js';
import { logger } from '../observability/logger.js';

export interface CandidateContent {
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
}

export interface Candidate extends CandidateContent, RoutingItem {
  target_memory_id: string | null;
}

export interface EvaluateDeps {
  /** The ONLY repository capability: a read. */
  contextSource: Pick<PromotionRepository, 'findJudgeContext'>;
  judge: Judge;
  routing: RoutingConfig;
}

export interface EvaluateOptions {
  projectId: string;
  /** Decision rebuilt from persisted columns (non-pending item); null → judge now. */
  persisted: RoutingDecision | null;
  /** Log correlation only: item id, or 'preview'. Never content. */
  logId: string;
}

export type CandidateEvaluation =
  | { kind: 'blocked'; sanitize: SanitizeResult & { block: SanitizeBlock } }
  | {
      kind: 'routed';
      sanitize: SanitizeResult;
      /** PII-masked when PII was found; otherwise the candidate's content. */
      content: CandidateContent;
      context: readonly JudgeContextItem[];
      decision: RoutingDecision;
      judged: boolean;
      route: RouteOutcome;
    };

export async function evaluateCandidate(
  c: Candidate,
  deps: EvaluateDeps,
  o: EvaluateOptions,
): Promise<CandidateEvaluation> {
  const s = sanitizeItem(c);
  if (s.block) return { kind: 'blocked', sanitize: { ...s, block: s.block } };

  const content: CandidateContent = s.masked ?? {
    title: c.title,
    summary: c.summary,
    body: c.body,
    fields: c.fields,
  };

  let context: readonly JudgeContextItem[] = [];
  let decision: RoutingDecision;
  let judged = false;
  if (o.persisted) {
    decision = o.persisted;
  } else {
    judged = true;
    const judgedResult = await judgeContent(c, content, deps, o);
    context = judgedResult.context;
    decision = judgedResult.result;
  }

  const route = routeDecision(decision, c, deps.routing);
  return { kind: 'routed', sanitize: s, content, context, decision, judged, route };
}

/** Context + judge + normalize. Never throws: failures → failClosed (queued, never applied). */
async function judgeContent(
  c: Candidate,
  content: CandidateContent,
  deps: EvaluateDeps,
  o: EvaluateOptions,
): Promise<{ context: readonly JudgeContextItem[]; result: JudgeResult }> {
  let context: JudgeContextItem[];
  try {
    context = await deps.contextSource.findJudgeContext(
      o.projectId,
      { title: content.title, summary: content.summary },
      c.target_memory_id,
    );
  } catch (err) {
    logger.warn('[promote] judge context unavailable — failing closed to review', {
      itemId: o.logId,
      errorName: errorName(err),
    });
    return { context: [], result: failClosed('judge_context_unavailable') };
  }

  let result: JudgeResult;
  try {
    result = await deps.judge.evaluate({ op: c.op, type: c.type, ...content }, context);
  } catch (err) {
    logger.warn('[promote] judge failed — failing closed to review', {
      itemId: o.logId,
      errorName: errorName(err),
    });
    return { context, result: failClosed('judge_unavailable') };
  }

  return { context, result: normalizeJudgeResult(result, context, { itemId: o.logId }) };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}
