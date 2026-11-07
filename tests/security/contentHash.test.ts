/**
 * computeContentHash unit tests (judge-structured-verdict C1, batch C).
 *
 * The function was extracted from the inline step-5 formula of
 * src/mcp/tools/remember.ts. Existing staged rows keep their hash only if the
 * output is byte-identical, so the golden vectors below were computed from the
 * pre-C1 inline implementation BEFORE the extraction and must never change.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { computeContentHash } from '../../src/security/hash.js';

/** Verbatim copy of the pre-C1 inline formula (remember.ts step 5 + sha256Hex). */
function legacyRememberHash(
  input: {
    op: string;
    type: string;
    title: string;
    summary: string;
    body: string;
    fields?: Record<string, unknown>;
  },
  targetMemoryId: string | null,
): string {
  const canonical = JSON.stringify({
    op: input.op,
    type: input.type,
    title: input.title,
    summary: input.summary,
    body: input.body,
    fields: input.fields ?? {},
    target: targetMemoryId,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

describe('computeContentHash — golden vectors (pre-C1 formula)', () => {
  it('matches the frozen hex for an add with fields', () => {
    const hash = computeContentHash({
      op: 'add',
      type: 'gotcha',
      title: 'Pool size gotcha',
      summary: 'Pool exhausts under load',
      body: 'The pool in src/db/pool.ts exhausts when max is 5.',
      fields: { severity: 'high' },
      target: null,
    });
    expect(hash).toBe('8f16cbf2ee32965e7c98dd67924f17a9030f9ace8446fea9e247b3727d52e071');
  });

  it('matches the frozen hex for an amend with a target, non-ASCII text and no fields', () => {
    const hash = computeContentHash({
      op: 'amend',
      type: 'decision',
      title: 'Título ñ',
      summary: 's',
      body: 'b',
      target: '0b9f6f1e-3c1a-4c53-9a53-0f2f3b6d2a11',
    });
    expect(hash).toBe('6dc7cc85e4a55285071261c62abe02b773757104cebef4890c69c9ec7c863812');
  });
});

describe('computeContentHash — equals the legacy inline formula', () => {
  const base = {
    op: 'supersede',
    type: 'pattern',
    title: 'Retry with jitter',
    summary: 'Use jittered backoff',
    body: 'Wrap calls in withRetry() from src/util/retry.ts.',
  };

  it('treats missing fields as an empty object (same as `input.fields ?? {}`)', () => {
    expect(computeContentHash({ ...base, target: null })).toBe(legacyRememberHash(base, null));
    expect(computeContentHash({ ...base, fields: {}, target: null })).toBe(
      legacyRememberHash({ ...base, fields: {} }, null),
    );
    expect(computeContentHash({ ...base, target: null })).toBe(
      computeContentHash({ ...base, fields: {}, target: null }),
    );
  });

  it('matches for nested fields and a target id', () => {
    const fields = { a: 1, nested: { list: ['x', 'y'], flag: true } };
    const target = '11111111-2222-4333-8444-555555555555';
    expect(computeContentHash({ ...base, fields, target })).toBe(
      legacyRememberHash({ ...base, fields }, target),
    );
  });
});

describe('computeContentHash — sensitivity', () => {
  const item = {
    op: 'add',
    type: 'gotcha',
    title: 't',
    summary: 's',
    body: 'b',
    fields: {},
    target: null,
  };

  it('is deterministic', () => {
    expect(computeContentHash(item)).toBe(computeContentHash({ ...item }));
  });

  it.each([
    ['op', { op: 'amend' }],
    ['type', { type: 'decision' }],
    ['title', { title: 'T' }],
    ['summary', { summary: 'S' }],
    ['body', { body: 'B' }],
    ['fields', { fields: { k: 'v' } }],
    ['target', { target: '0b9f6f1e-3c1a-4c53-9a53-0f2f3b6d2a11' }],
  ])('changes when %s changes', (_name, patch) => {
    expect(computeContentHash({ ...item, ...patch })).not.toBe(computeContentHash(item));
  });

  it('returns 64 lowercase hex characters', () => {
    expect(computeContentHash(item)).toMatch(/^[0-9a-f]{64}$/);
  });
});
