/**
 * Pure governance-insights logic (C12): live judge rates, audit row → activity
 * event mapping (action code, actor, target, allow-listed facts) and the
 * activity keyset cursor bounds. No database.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_CATEGORY,
  WINDOW_DAYS,
  judgeRates,
  parseActivityCursor,
  rateOf,
  toActivityEvent,
  type RawActivityRow,
} from '../../src/db/insightsMapping.js';

const TS = new Date('2026-11-08T10:00:00.000Z');

function row(p: Partial<RawActivityRow>): RawActivityRow {
  return {
    id: '42',
    ts: TS,
    actor_kind: 'user',
    action: 'update',
    detail: {},
    job_count: null,
    actor_name: null,
    session_branch: null,
    m_type: null,
    m_title: null,
    i_type: null,
    i_title: null,
    q_type: null,
    q_title: null,
    ...p,
  };
}

describe('judge rates', () => {
  it('uses a 30-day window', () => {
    expect(WINDOW_DAYS).toBe(30);
  });

  it('FP = (ua + rj) / (ua + rj + aa); FN = ar / (ar + ur) — spec scenario', () => {
    const r = judgeRates({
      uncertainApproved: 2,
      uncertainRejected: 2,
      acceptedApproved: 5,
      acceptedRejected: 1,
      restoredFromJudge: 1,
    });
    expect(r.falsePositive).toEqual({ count: 3, of: 8, rate: 0.375 });
    expect(r.falseNegative).toEqual({ count: 1, of: 3, rate: 1 / 3 });
  });

  it('judge restores alone are false positives', () => {
    const r = judgeRates({
      uncertainApproved: 0,
      uncertainRejected: 0,
      acceptedApproved: 0,
      acceptedRejected: 0,
      restoredFromJudge: 2,
    });
    expect(r.falsePositive).toEqual({ count: 2, of: 2, rate: 1 });
  });

  it('a zero denominator gives rate null (counts still returned)', () => {
    const r = judgeRates({
      uncertainApproved: 0,
      uncertainRejected: 0,
      acceptedApproved: 0,
      acceptedRejected: 0,
      restoredFromJudge: 0,
    });
    expect(r.falsePositive).toEqual({ count: 0, of: 0, rate: null });
    expect(r.falseNegative).toEqual({ count: 0, of: 0, rate: null });
    expect(rateOf(0, 4)).toEqual({ count: 0, of: 4, rate: 0 });
  });
});

describe('activity action mapping', () => {
  it.each<[string, Partial<RawActivityRow>, string]>([
    ['remember', { action: 'stage', detail: { tool: 'remember' } }, 'staging.remember'],
    ['discard', { action: 'stage', detail: { tool: 'discard_staged' } }, 'staging.discard'],
    ['promote', { action: 'promote', actor_kind: 'ci' }, 'promotion.run'],
    [
      'closed unmerged',
      { action: 'delete', actor_kind: 'ci', detail: { event: 'closed_unmerged' } },
      'promotion.abandon',
    ],
    ['approve', { detail: { api: 'review_queue.approve' } }, 'review.approve'],
    ['reject', { detail: { api: 'review_queue.reject' } }, 'review.reject'],
    ['restore', { detail: { api: 'quarantine.restore' } }, 'quarantine.restore'],
    ['create', { detail: { api: 'memory.create' } }, 'memory.create'],
    ['amend', { detail: { api: 'memory.amend' } }, 'memory.amend'],
    ['confirm', { detail: { api: 'memory.confirm' } }, 'memory.confirm'],
    ['retire', { detail: { api: 'memory.retire' } }, 'memory.retire'],
    ['retire by pr', { detail: { api: 'memory.retire_by_pr' } }, 'memory.retire_by_pr'],
    [
      'purge job',
      { action: 'admin', actor_kind: 'system', detail: { job: 'quarantine-purge' } },
      'job.quarantine_purge',
    ],
    [
      'revalidation job',
      { action: 'admin', actor_kind: 'system', detail: { job: 'revalidation-sweep' } },
      'job.revalidation_sweep',
    ],
    [
      'reaper job',
      { action: 'admin', actor_kind: 'system', detail: { job: 'web-session-reaper' } },
      'job.web_session_reaper',
    ],
  ])('%s → %s', (_label, p, code) => {
    expect(toActivityEvent(row(p)).action).toBe(code);
  });

  it.each<[string, Partial<RawActivityRow>]>([
    ['unknown api', { detail: { api: 'memory.explode' } }],
    ['unknown tool', { action: 'stage', detail: { tool: 'recall' } }],
    ['unknown job', { action: 'admin', actor_kind: 'system', detail: { job: 'mystery' } }],
    ['delete without event', { action: 'delete', actor_kind: 'ci' }],
    ['non-string api', { detail: { api: 7 } }],
    ['null detail', { detail: null }],
  ])('%s → other', (_label, p) => {
    expect(toActivityEvent(row(p)).action).toBe('other');
  });

  it('every action code has a category (other has none)', () => {
    expect(ACTIVITY_CATEGORY['review.approve']).toBe('review');
    expect(ACTIVITY_CATEGORY['promotion.abandon']).toBe('promotion');
    expect(ACTIVITY_CATEGORY['job.quarantine_purge']).toBe('jobs');
    expect(ACTIVITY_CATEGORY.other).toBeNull();
  });
});

describe('activity actor', () => {
  it('ci and system never carry a name', () => {
    expect(
      toActivityEvent(row({ action: 'promote', actor_kind: 'ci', actor_name: 'x' })).actor,
    ).toEqual({ kind: 'ci', name: null });
    expect(
      toActivityEvent(row({ action: 'admin', actor_kind: 'system', actor_name: 'x' })).actor,
    ).toEqual({ kind: 'system', name: null });
  });

  it('a user row from an MCP tool is an agent acting for that user', () => {
    expect(
      toActivityEvent(row({ action: 'stage', detail: { tool: 'remember' }, actor_name: 'Ana' }))
        .actor,
    ).toEqual({ kind: 'agent', name: 'Ana' });
  });

  it('a REST row is the user; missing name stays null', () => {
    expect(
      toActivityEvent(row({ detail: { api: 'memory.retire' }, actor_name: 'Diego' })).actor,
    ).toEqual({ kind: 'user', name: 'Diego' });
    expect(toActivityEvent(row({ detail: { api: 'memory.retire' } })).actor).toEqual({
      kind: 'user',
      name: null,
    });
  });

  it('the agent enum maps to agent', () => {
    expect(toActivityEvent(row({ actor_kind: 'agent', actor_name: 'Bot' })).actor).toEqual({
      kind: 'agent',
      name: 'Bot',
    });
  });
});

describe('activity facts', () => {
  it('promotion: branch from the session, PR and counters (uncertain → queued)', () => {
    const e = toActivityEvent(
      row({
        action: 'promote',
        actor_kind: 'ci',
        session_branch: 'feature/login',
        detail: { prNumber: 12, applied: 3, uncertain: 1, quarantined: 1 },
      }),
    );
    expect(e.facts).toEqual({
      branch: 'feature/login',
      prNumber: 12,
      applied: 3,
      queued: 1,
      quarantined: 1,
    });
  });

  it('abandon: branch, PR and discarded count', () => {
    const e = toActivityEvent(
      row({
        action: 'delete',
        actor_kind: 'ci',
        detail: { event: 'closed_unmerged', branch: 'feature/x', prNumber: 4, discarded: 2 },
      }),
    );
    expect(e.facts).toEqual({ branch: 'feature/x', prNumber: 4, discarded: 2 });
  });

  it('staging: branch only', () => {
    const e = toActivityEvent(
      row({ action: 'stage', detail: { tool: 'remember', branch: 'feature/y', applied: 9 } }),
    );
    expect(e.facts).toEqual({ branch: 'feature/y' });
  });

  it('restore/create/amend: outcome only when it is a known value', () => {
    expect(
      toActivityEvent(row({ detail: { api: 'quarantine.restore', outcome: 'queued' } })).facts,
    ).toEqual({ outcome: 'queued' });
    expect(
      toActivityEvent(row({ detail: { api: 'memory.create', outcome: 'exploded' } })).facts,
    ).toEqual({});
  });

  it('retire by PR: originPr and count (= resultCount)', () => {
    expect(
      toActivityEvent(row({ detail: { api: 'memory.retire_by_pr', originPr: 7, resultCount: 3 } }))
        .facts,
    ).toEqual({ originPr: 7, count: 3 });
  });

  it('jobs: this project count from job_count', () => {
    expect(
      toActivityEvent(
        row({
          action: 'admin',
          actor_kind: 'system',
          detail: { job: 'quarantine-purge' },
          job_count: 2,
        }),
      ).facts,
    ).toEqual({ count: 2 });
  });

  it('drops non-number, negative or fractional counters and non-string branches', () => {
    const e = toActivityEvent(
      row({
        action: 'promote',
        actor_kind: 'ci',
        session_branch: null,
        detail: { prNumber: '12', applied: -1, uncertain: 1.5, quarantined: null },
      }),
    );
    expect(e.facts).toEqual({});
    const j = toActivityEvent(
      row({
        action: 'admin',
        actor_kind: 'system',
        detail: { job: 'quarantine-purge' },
        job_count: '2',
      }),
    );
    expect(j.facts).toEqual({});
  });

  it('never copies unknown detail keys (hashes, ids, merge sha)', () => {
    const e = toActivityEvent(
      row({
        action: 'promote',
        actor_kind: 'ci',
        detail: { mergeSha: 'deadbeef', sessionId: 'S1', repoId: 'R1', userId: 'U1', prNumber: 1 },
      }),
    );
    const text = JSON.stringify(e);
    for (const leak of ['deadbeef', 'S1', 'R1', 'U1']) expect(text).not.toContain(leak);
  });
});

describe('activity target', () => {
  it('memory first, then staging item (PII-masked), then quarantine', () => {
    expect(
      toActivityEvent(
        row({ m_type: 'decision', m_title: 'Mem', i_type: 'pattern', i_title: 'Item' }),
      ).target,
    ).toEqual({ kind: 'memory', type: 'decision', title: 'Mem' });
    expect(
      toActivityEvent(row({ i_type: 'pattern', i_title: 'Ask ana@example.com', q_type: 'gotcha' }))
        .target,
    ).toEqual({ kind: 'staging_item', type: 'pattern', title: 'Ask [EMAIL]' });
    expect(toActivityEvent(row({ q_type: 'gotcha', q_title: 'Q' })).target).toEqual({
      kind: 'quarantine',
      type: 'gotcha',
      title: 'Q',
    });
  });

  it('nothing resolvable → null', () => {
    expect(toActivityEvent(row({})).target).toBeNull();
  });

  it('id and timestamp are carried as strings', () => {
    const e = toActivityEvent(row({ id: '9001' }));
    expect(e.id).toBe('9001');
    expect(e.at).toBe(TS.toISOString());
  });
});

describe('activity cursor', () => {
  it.each(['1', '50', '9223372036854775807'])('%s is valid', (c) => {
    expect(parseActivityCursor(c)).toBe(c);
  });

  it.each(['0', '-1', '01', 'abc', '', '1.5', '9223372036854775808', '12345678901234567890'])(
    '%s is invalid',
    (c) => {
      expect(parseActivityCursor(c)).toBeNull();
    },
  );
});
