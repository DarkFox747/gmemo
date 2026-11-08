import { describe, it, expect } from 'vitest';
import {
  REDACTED_TOKEN,
  TEXT_BUDGET,
  WHOLE_REDACTION,
  finalizeRedaction,
  isSecretFree,
  redactSecretSpans,
  type RedactableContent,
} from '../../src/security/secretRedact.js';
import { scanForSecrets } from '../../src/security/secretScan.js';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_VALUE, SECRET_FIXTURES } from './secretFixtures.js';

const content = (over: Partial<RedactableContent> = {}): RedactableContent => ({
  title: 'Deploy issue',
  summary: 'Short summary',
  body: 'Plain body',
  fields: {},
  ...over,
});

const WHOLE = { ...WHOLE_REDACTION, fields: {} };

describe('redactSecretSpans', () => {
  it('replaces multiple spans right to left and keeps the context', () => {
    const body = 'First AKIAIOSFODNN7EXAMPLE then ghp_1234567890abcdefghij end.';
    const r = redactSecretSpans(content({ body }));
    expect(r.content.body).toBe(`First ${REDACTED_TOKEN} then ${REDACTED_TOKEN} end.`);
    expect(r.ranges).toBe(2);
  });

  it('redacts per string leaf of fields and never rewrites keys', () => {
    const r = redactSecretSpans(
      content({ fields: { how: 'use AKIAIOSFODNN7EXAMPLE', list: ['ok', 'xoxb-abc-def'], n: 3 } }),
    );
    expect(r.content.fields).toEqual({
      how: `use ${REDACTED_TOKEN}`,
      list: ['ok', REDACTED_TOKEN],
      n: 3,
    });
    expect(r.ranges).toBe(2);
  });

  it('throws RangeError on fields nested 5 levels deep', () => {
    expect(() =>
      redactSecretSpans(content({ fields: { a: { b: { c: { d: { e: 'x' } } } } } })),
    ).toThrow(RangeError);
  });
});

describe('finalizeRedaction', () => {
  it('ranges = 0 → whole redaction', () => {
    expect(finalizeRedaction(content(), 0)).toEqual(WHOLE);
  });

  it('a clamp that would split the sentinel → whole field', () => {
    const title = 'x'.repeat(TEXT_BUDGET.title - 5) + REDACTED_TOKEN;
    const out = finalizeRedaction(content({ title }), 1);
    expect(out.title).toBe(REDACTED_TOKEN);
    expect(out.body).toBe('Plain body');
  });

  it('a clamp outside the sentinel → slice', () => {
    const title = REDACTED_TOKEN + 'y'.repeat(TEXT_BUDGET.title);
    const out = finalizeRedaction(content({ title }), 1);
    expect(out.title).toHaveLength(TEXT_BUDGET.title);
    expect(out.title.startsWith(REDACTED_TOKEN)).toBe(true);
  });

  it('a secret in a fields key → whole item', () => {
    const c = content({ body: 'AKIAIOSFODNN7EXAMPLE', fields: { AKIAIOSFODNN7EXAMPLE: 'value' } });
    const r = redactSecretSpans(c);
    expect(r.ranges).toBe(1);
    expect(finalizeRedaction(r.content, r.ranges)).toEqual(WHOLE);
  });

  it('a residual secret after the spans → whole item', () => {
    const c = content({ body: 'password:\n abcdefghijklmnop and AKIAIOSFODNN7EXAMPLE' });
    const r = redactSecretSpans(c);
    expect(r.ranges).toBe(1);
    expect(finalizeRedaction(r.content, r.ranges)).toEqual(WHOLE);
  });
});

describe('isSecretFree', () => {
  it('a [REDACTADO] assignment leaf does not trip the verify', () => {
    expect(isSecretFree(content({ fields: { note: `password: ${REDACTED_TOKEN}` } }))).toBe(true);
  });

  it('catches a zero-width split secret', () => {
    expect(isSecretFree(content({ body: 'AKIAIOSFOD​NN7EXAMPLE' }))).toBe(false);
  });

  it('a throw counts as not free', () => {
    expect(isSecretFree(content({ fields: { a: { b: { c: { d: { e: 'x' } } } } } }))).toBe(false);
  });

  // The AWS detector is context-anchored: a key/value pair whose KEY is the context
  // leaves a bare 40-char leaf that per-leaf scans cannot see. The fields JSON is
  // also scanned so such a leaf never survives a partial span redaction.
  it('an AWS secret whose context is the fields key is not secret-free', () => {
    const c = content({ fields: { aws_secret_access_key: AWS_SECRET_VALUE } });
    expect(isSecretFree(c)).toBe(false);
    const r = redactSecretSpans({ ...c, body: 'Key AKIAIOSFODNN7EXAMPLE leaked' });
    const out = finalizeRedaction(r.content, r.ranges);
    expect(JSON.stringify(out)).not.toContain(AWS_SECRET_VALUE);
  });

  it('an AWS key pair split across a text and a field is not secret-free', () => {
    const c = content({ title: `Key ${AWS_ACCESS_KEY_ID}`, fields: { s: AWS_SECRET_VALUE } });
    expect(isSecretFree(c)).toBe(false);
  });

  it('a bare 40-char token alone is secret-free (no access key id)', () => {
    expect(isSecretFree(content({ body: `sha ${AWS_SECRET_VALUE}` }))).toBe(true);
  });

  // 4.5: invisible characters outside \p{Cf} cannot split a key either.
  it.each([
    ['combining grapheme joiner', '\u034F'],
    ['Hangul choseong filler', '\u115F'],
    ['Hangul jungseong filler', '\u1160'],
    ['Hangul filler', '\u3164'],
    ['halfwidth Hangul filler (NFKC → U+1160)', '\uFFA0'],
    ['Braille blank', '\u2800'],
    ['variation selector 16', '\uFE0F'],
    ['variation selector 1', '\uFE00'],
  ])('catches a secret split by a %s', (_label, ch) => {
    expect(isSecretFree(content({ body: `AKIAIOSFOD${ch}NN7EXAMPLE` }))).toBe(false);
  });

  it('a redacted password leaf still counts as secret-free (JSON quoting)', () => {
    expect(isSecretFree(content({ fields: { password: REDACTED_TOKEN } }))).toBe(true);
  });

  it.each(SECRET_FIXTURES)('every unit of finalize(redact($category)) is secret-free', (f) => {
    const c = content({ body: f.text, fields: { k: f.text } });
    const r = redactSecretSpans(c);
    const out = finalizeRedaction(r.content, r.ranges);
    expect(isSecretFree(out)).toBe(true);
    for (const unit of [out.title, out.summary, out.body, ...Object.values(out.fields)]) {
      expect(scanForSecrets(String(unit))).toEqual([]);
      expect(String(unit)).not.toContain(f.secret);
    }
    // The surrounding text survived (not a whole-item false pass).
    expect(out.body).toContain(REDACTED_TOKEN);
    expect(out.body).not.toBe(REDACTED_TOKEN);
    expect(out.title).toBe('Deploy issue');
  });
});
