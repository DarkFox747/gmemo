/**
 * DeterministicJudge — ordered heuristic rules 1–7 (C1 design, "DeterministicJudge").
 *
 * One test per rule using its demo trigger, plus precedence (first match wins),
 * determinism, the acceptedConfidence knob, the smoke item, and the
 * "pipeline miss" assertion: every rule-1 demo phrase must pass the pipeline
 * detectors (scanForSecrets / scanForInjection), otherwise the second layer
 * would be unreachable in the demo.
 */

import { describe, it, expect } from 'vitest';
import { DeterministicJudge } from '../../src/judge/deterministicJudge.js';
import { scanForSecrets } from '../../src/security/secretScan.js';
import { scanForInjection } from '../../src/security/injectionScan.js';
import type { JudgeContextItem, JudgeItem, JudgeResult } from '../../src/judge/judge.js';

const CTX_A = '0b9f6c1e-3a2d-4c5b-8e7f-1a2b3c4d5e6f';
const CTX_B = '11111111-2222-4333-8444-555555555555';

/** A clean item that lands on rule 7 (gotcha, grounded, specific, no hedge). */
const BASE: JudgeItem = {
  op: 'add',
  type: 'gotcha',
  title: 'Pool exhaustion under parallel promote',
  summary: 'Parallel promote calls can exhaust the pg pool.',
  body: 'Running two promote requests at once exhausts the pool configured in src/db/pool.ts.',
  fields: {},
};

const judge = new DeterministicJudge({ acceptedConfidence: 0.9 });

function item(overrides: Partial<JudgeItem> = {}): JudgeItem {
  return { ...BASE, ...overrides };
}

function ctx(id: string, title: string, type: JudgeItem['type'] = 'decision'): JudgeContextItem {
  return { id, type, title, summary: 'context summary' };
}

const RULE1_PHRASES = [
  'The staging DB password is hunter2 until rotation.',
  'La contraseña es tigre123 hasta el lunes.',
  'Use the base64 blob b64: QWxhZGRpbjpvcGVuIHNlc2FtZQQWxhZGRpbjpvcGVu for the header.',
];

describe('rule 1 — natural-language credential / encoded blob → rejected/security_second_layer', () => {
  it.each(RULE1_PHRASES)('rejects body %j', async (body) => {
    const r = await judge.evaluate(item({ body: `${body} See src/db/pool.ts for details.` }), []);
    expect(r).toMatchObject({
      verdict: 'rejected',
      criterion: 'security_second_layer',
      confidence: 0.95,
      relatedMemoryId: null,
    });
  });

  it('also scans title and summary', async () => {
    const r = await judge.evaluate(item({ summary: 'The admin passwd was s3cr3tpw' }), []);
    expect(r.criterion).toBe('security_second_layer');
  });

  it('never echoes the credential in the reason', async () => {
    const r = await judge.evaluate(item({ body: RULE1_PHRASES[0] }), []);
    expect(r.reason).not.toContain('hunter2');
  });

  it('rule-1 demo phrases are missed by the pipeline secret scanner', () => {
    for (const phrase of RULE1_PHRASES) {
      expect(scanForSecrets(phrase)).toEqual([]);
    }
  });

  it('rule-1 demo phrases are missed by the pipeline injection scanner', () => {
    for (const phrase of RULE1_PHRASES) {
      expect(scanForInjection(phrase)).toEqual([]);
    }
  });
});

describe('rule 2 — not specific → rejected/specificity', () => {
  it.each([
    ['short body', { body: 'fix it' }],
    ['fewer than 3 meaningful tokens', { body: 'the and for with that this from are' }],
    ['generic title "todo"', { title: 'todo' }],
    ['generic title "WIP!"', { title: 'WIP!' }],
  ])('%s', async (_label, overrides) => {
    const r = await judge.evaluate(item(overrides as Partial<JudgeItem>), []);
    expect(r).toMatchObject({
      verdict: 'rejected',
      criterion: 'specificity',
      confidence: 0.9,
      relatedMemoryId: null,
    });
  });
});

describe('rule 3 — same normalised title as a context memory → rejected/duplication', () => {
  it('matches any type, first in context order, and references it', async () => {
    const context = [
      ctx(CTX_A, 'Unrelated memory about caching', 'pattern'),
      ctx(CTX_B, 'pool EXHAUSTION — under parallel promote!', 'outcome'),
    ];
    const r = await judge.evaluate(item(), context);
    expect(r).toMatchObject({
      verdict: 'rejected',
      criterion: 'duplication',
      confidence: 0.95,
      relatedMemoryId: CTX_B,
    });
  });
});

describe('rule 4 — near-identical same-type title → uncertain/contradiction', () => {
  const seedTitle =
    'content_tsv is generated with to_tsvector english weighted A/B/C over title summary body';
  const stagedTitle =
    'content_tsv generated with to_tsvector simple weighted A/B/C over title summary body';

  it('flags the demo pair and references the context memory', async () => {
    const r = await judge.evaluate(item({ type: 'decision', title: stagedTitle }), [
      ctx(CTX_A, seedTitle, 'decision'),
    ]);
    expect(r).toMatchObject({
      verdict: 'uncertain',
      criterion: 'contradiction',
      confidence: 0.7,
      relatedMemoryId: CTX_A,
    });
  });

  it('does not fire across different types', async () => {
    const r = await judge.evaluate(item({ type: 'decision', title: stagedTitle }), [
      ctx(CTX_A, seedTitle, 'pattern'),
    ]);
    expect(r.criterion).toBe('confidence');
  });

  it('does not fire with fewer than 3 shared tokens (two-token titles)', async () => {
    const r = await judge.evaluate(item({ title: 'Smoke abc123' }), [
      ctx(CTX_A, 'Smoke xyz789', 'gotcha'),
    ]);
    expect(r.verdict).toBe('accepted');
  });
});

describe('rule 5 — gotcha/integration_note without a concrete artefact → uncertain/grounding', () => {
  const ungrounded = 'Deploys sometimes fail on Mondays, be careful with it.';

  it.each(['gotcha', 'integration_note'] as const)('%s without artefact', async (type) => {
    const r = await judge.evaluate(item({ type, body: ungrounded }), []);
    expect(r).toMatchObject({
      verdict: 'uncertain',
      criterion: 'grounding',
      confidence: 0.6,
      relatedMemoryId: null,
    });
  });

  it('other types are not checked for grounding', async () => {
    const r = await judge.evaluate(item({ type: 'pattern', body: ungrounded }), []);
    expect(r.verdict).toBe('accepted');
  });

  it.each([
    ['path', 'Deploys fail when infra/deploy/run is missing its flag.'],
    ['file extension', 'Deploys fail when config.yaml lacks the region entry.'],
    ['backticks', 'Deploys fail unless you run `pnpm migrate` before starting.'],
    ['UPPER_SNAKE', 'Deploys fail when BEDROCK_MODEL_ID is not fully qualified.'],
    ['call', 'Deploys fail because loadConfig() exits on invalid values.'],
    ['URL', 'Deploys fail during outages, check https://status.aws.amazon.com first.'],
  ])('a %s counts as an artefact reference', async (_label, body) => {
    const r = await judge.evaluate(item({ body }), []);
    expect(r.criterion).not.toBe('grounding');
  });
});

describe('rule 6 — hedge term → accepted/confidence at fixed 0.6', () => {
  it.each([
    'Timeouts are probably caused by the pool size in src/db/pool.ts.',
    'Timeouts might come from the pool size in src/db/pool.ts.',
    'Creo que el timeout viene del pool en src/db/pool.ts y de la red.',
    'Tal vez el timeout viene del pool en src/db/pool.ts y de la red.',
  ])('body %j', async (body) => {
    const r = await judge.evaluate(item({ body }), []);
    expect(r).toMatchObject({
      verdict: 'accepted',
      criterion: 'confidence',
      confidence: 0.6,
      relatedMemoryId: null,
    });
  });

  it('is fixed even when acceptedConfidence is higher', async () => {
    const j = new DeterministicJudge({ acceptedConfidence: 1 });
    const r = await j.evaluate(
      item({ body: 'Maybe the pool in src/db/pool.ts is too small.' }),
      [],
    );
    expect(r.confidence).toBe(0.6);
  });
});

describe('rule 7 — default → accepted/confidence at acceptedConfidence', () => {
  it('uses the configured acceptedConfidence', async () => {
    const r = await judge.evaluate(item(), []);
    expect(r).toMatchObject({
      verdict: 'accepted',
      criterion: 'confidence',
      confidence: 0.9,
      relatedMemoryId: null,
    });
    const low = await new DeterministicJudge({ acceptedConfidence: 0.5 }).evaluate(item(), []);
    expect(low.confidence).toBe(0.5);
  });

  it('the smoke item lands on rule 7 (accepted at 0.9)', async () => {
    const runId = 'mhn3k2x1';
    const smoke = item({
      type: 'gotcha',
      title: `Smoke ${runId}`,
      summary: `Smoke test item ${runId}`,
      body: `Created by scripts/smoke.ts, run ${runId}.`,
    });
    const r = await judge.evaluate(smoke, [ctx(CTX_A, 'Smoke otherrun', 'gotcha')]);
    expect(r).toMatchObject({ verdict: 'accepted', criterion: 'confidence', confidence: 0.9 });
  });
});

describe('precedence and determinism', () => {
  it('duplication + hedge → duplication (rule 3 before rule 6)', async () => {
    const r = await judge.evaluate(
      item({ body: 'Probably the pool in src/db/pool.ts is too small for this.' }),
      [ctx(CTX_A, BASE.title, 'gotcha')],
    );
    expect(r.criterion).toBe('duplication');
  });

  it('credential + generic title → security_second_layer (rule 1 before rule 2)', async () => {
    const r = await judge.evaluate(item({ title: 'todo', body: RULE1_PHRASES[0] }), []);
    expect(r.criterion).toBe('security_second_layer');
  });

  it('same input twice → identical output', async () => {
    const context = [ctx(CTX_A, 'Something else entirely here', 'gotcha')];
    const a: JudgeResult = await judge.evaluate(item(), context);
    const b: JudgeResult = await judge.evaluate(item(), context);
    expect(a).toEqual(b);
  });

  it('every result has a non-empty reason', async () => {
    const r = await judge.evaluate(item(), []);
    expect(r.reason.length).toBeGreaterThan(0);
  });
});
