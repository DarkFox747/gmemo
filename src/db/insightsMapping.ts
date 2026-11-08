/**
 * Pure, DB-free logic of the governance insights read model (C12):
 *
 *  - judgeRates: live false-positive / false-negative indicators from stored
 *    human labels. "Positive" = the Juez held the unit back (uncertain, or
 *    rejected with a judge criterion), as in scripts/eval.ts.
 *      FP = (uncertainApproved + restoredFromJudge)
 *           / (uncertainApproved + restoredFromJudge + acceptedApproved)
 *      FN = acceptedRejected / (acceptedRejected + uncertainRejected)
 *    A rate is null when its denominator is 0.
 *  - toActivityEvent: one access_log row → ActivityEventDto. Only allow-listed
 *    facts are copied, each type-guarded; actor names are display names only
 *    and never for CI or system rows; staging titles are PII-masked.
 *  - parseActivityCursor: the keyset cursor is a positive int8 access_log.id.
 */

import { maskPii } from '../security/piiMask.js';
import type { MemoryType } from '../contracts/memory.js';
import type {
  ActivityAction,
  ActivityCategory,
  ActivityEventDto,
  ActivityFactsDto,
  ActorKind,
  RateDto,
} from '../http/api/types.js';

/** Window of the dashboard judge section (days). */
export const WINDOW_DAYS = 30;

/** Closed staging sessions are listed for this many days after closing. */
export const CLOSED_SESSION_DAYS = 7;

export function rateOf(count: number, of: number): RateDto {
  return { count, of, rate: of === 0 ? null : count / of };
}

export interface JudgeLabelCounts {
  uncertainApproved: number;
  uncertainRejected: number;
  acceptedApproved: number;
  acceptedRejected: number;
  restoredFromJudge: number;
}

export function judgeRates(l: JudgeLabelCounts): {
  falsePositive: RateDto;
  falseNegative: RateDto;
} {
  const heldBackGood = l.uncertainApproved + l.restoredFromJudge;
  return {
    falsePositive: rateOf(heldBackGood, heldBackGood + l.acceptedApproved),
    falseNegative: rateOf(l.acceptedRejected, l.acceptedRejected + l.uncertainRejected),
  };
}

/**
 * Category of each action code (the activity `category` filter). The SQL
 * filter in insightsRepository.ts mirrors this table; an integration test
 * checks that every filtered event maps back to its category.
 */
export const ACTIVITY_CATEGORY: Record<ActivityAction, ActivityCategory | null> = {
  'staging.remember': 'staging',
  'staging.discard': 'staging',
  'promotion.run': 'promotion',
  'promotion.abandon': 'promotion',
  'review.approve': 'review',
  'review.reject': 'review',
  'quarantine.restore': 'quarantine',
  'memory.create': 'memory',
  'memory.amend': 'memory',
  'memory.confirm': 'memory',
  'memory.retire': 'memory',
  'memory.retire_by_pr': 'memory',
  'job.quarantine_purge': 'jobs',
  'job.revalidation_sweep': 'jobs',
  'job.web_session_reaper': 'jobs',
  other: null,
};

const API_ACTIONS: Readonly<Record<string, ActivityAction>> = {
  'review_queue.approve': 'review.approve',
  'review_queue.reject': 'review.reject',
  'quarantine.restore': 'quarantine.restore',
  'memory.create': 'memory.create',
  'memory.amend': 'memory.amend',
  'memory.confirm': 'memory.confirm',
  'memory.retire': 'memory.retire',
  'memory.retire_by_pr': 'memory.retire_by_pr',
};

const TOOL_ACTIONS: Readonly<Record<string, ActivityAction>> = {
  remember: 'staging.remember',
  discard_staged: 'staging.discard',
};

const JOB_ACTIONS: Readonly<Record<string, ActivityAction>> = {
  'quarantine-purge': 'job.quarantine_purge',
  'revalidation-sweep': 'job.revalidation_sweep',
  'web-session-reaper': 'job.web_session_reaper',
};

/**
 * One activity row as selected by the repository. `detail` holds ONLY the
 * allow-listed keys extracted in SQL (never the stored detail object), and
 * `job_count` is this project's count for a job row.
 */
export interface RawActivityRow {
  id: string;
  ts: Date;
  actor_kind: string;
  action: string;
  detail: Record<string, unknown> | null;
  job_count: unknown;
  actor_name: string | null;
  session_branch: string | null;
  m_type: MemoryType | null;
  m_title: string | null;
  i_type: MemoryType | null;
  i_title: string | null;
  q_type: MemoryType | null;
  q_title: string | null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

const BRANCH_MAX = 200;

function capped(v: string | undefined): string | undefined {
  return v === undefined ? v : v.slice(0, BRANCH_MAX);
}

function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

function lookup(table: Readonly<Record<string, ActivityAction>>, key: unknown): ActivityAction {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key)
    ? table[key]!
    : 'other';
}

function actionOf(r: RawActivityRow, d: Record<string, unknown>): ActivityAction {
  switch (r.action) {
    case 'stage':
      return lookup(TOOL_ACTIONS, d.tool);
    case 'promote':
      return r.actor_kind === 'ci' ? 'promotion.run' : 'other';
    case 'delete':
      return d.event === 'closed_unmerged' ? 'promotion.abandon' : 'other';
    case 'update':
      return lookup(API_ACTIONS, d.api);
    case 'admin':
      return r.actor_kind === 'system' ? lookup(JOB_ACTIONS, d.job) : 'other';
    default:
      return 'other';
  }
}

function actorOf(r: RawActivityRow, d: Record<string, unknown>): ActivityEventDto['actor'] {
  const name = r.actor_name ?? null;
  let kind: ActorKind;
  switch (r.actor_kind) {
    case 'ci':
      return { kind: 'ci', name: null };
    case 'system':
      return { kind: 'system', name: null };
    case 'agent':
      kind = 'agent';
      break;
    default:
      // A user row written by an MCP tool is an agent acting for that user.
      kind = typeof d.tool === 'string' ? 'agent' : 'user';
  }
  return { kind, name };
}

function factsOf(
  action: ActivityAction,
  r: RawActivityRow,
  d: Record<string, unknown>,
): ActivityFactsDto {
  const f: ActivityFactsDto = {};
  const put = <K extends keyof ActivityFactsDto>(
    k: K,
    v: ActivityFactsDto[K] | undefined,
  ): void => {
    if (v !== undefined) f[k] = v;
  };
  switch (action) {
    case 'staging.remember':
    case 'staging.discard':
      put('branch', capped(str(d.branch)));
      break;
    case 'promotion.run':
      put('branch', capped(str(r.session_branch)));
      put('prNumber', count(d.prNumber));
      put('applied', count(d.applied));
      put('queued', count(d.uncertain));
      put('quarantined', count(d.quarantined));
      break;
    case 'promotion.abandon':
      put('branch', capped(str(d.branch) ?? str(r.session_branch)));
      put('prNumber', count(d.prNumber));
      put('discarded', count(d.discarded));
      break;
    case 'quarantine.restore':
    case 'memory.create':
    case 'memory.amend':
      if (d.outcome === 'applied' || d.outcome === 'queued' || d.outcome === 'quarantined') {
        f.outcome = d.outcome;
      }
      break;
    case 'memory.retire_by_pr':
      put('originPr', count(d.originPr));
      put('count', count(d.resultCount));
      break;
    case 'job.quarantine_purge':
    case 'job.revalidation_sweep':
    case 'job.web_session_reaper':
      put('count', count(r.job_count));
      break;
    default:
      break;
  }
  return f;
}

function targetOf(r: RawActivityRow): ActivityEventDto['target'] {
  if (r.m_type && r.m_title !== null) return { kind: 'memory', type: r.m_type, title: r.m_title };
  if (r.i_type && r.i_title !== null) {
    // Staging titles may predate promotion-time PII masking.
    return { kind: 'staging_item', type: r.i_type, title: maskPii(r.i_title).text };
  }
  if (r.q_type && r.q_title !== null) {
    return { kind: 'quarantine', type: r.q_type, title: maskPii(r.q_title).text };
  }
  return null;
}

export function toActivityEvent(r: RawActivityRow): ActivityEventDto {
  const d = r.detail ?? {};
  const action = actionOf(r, d);
  return {
    id: r.id,
    at: r.ts.toISOString(),
    action,
    actor: actorOf(r, d),
    target: targetOf(r),
    facts: factsOf(action, r, d),
  };
}

const CURSOR_RE = /^[1-9][0-9]{0,18}$/;
const INT8_MAX = 9223372036854775807n;

/** A valid cursor is a positive int8 written without leading zeros; anything else → null. */
export function parseActivityCursor(raw: string): string | null {
  if (!CURSOR_RE.test(raw)) return null;
  return BigInt(raw) <= INT8_MAX ? raw : null;
}
