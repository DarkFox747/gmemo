import { describe, it, expect } from 'vitest';
import { scanForSecrets, scanForSecretsWithRanges } from '../../src/security/secretScan.js';
import {
  ANTHROPIC_STYLE_KEY,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_VALUE,
  GITHUB_FINE_GRAINED_PAT,
  OPENAI_PROJECT_KEY,
  SECRET_FIXTURES,
} from './secretFixtures.js';

const covered = (text: string, secret: string): boolean => {
  const start = text.indexOf(secret);
  const end = start + secret.length;
  return scanForSecretsWithRanges(text).ranges.some((r) => r.start <= start && r.end >= end);
};

describe('scanForSecretsWithRanges', () => {
  it.each(SECRET_FIXTURES)('locates a $category span wherever the detector hits', (f) => {
    const r = scanForSecretsWithRanges(f.text);
    expect(r.categories).toContain(f.category);
    expect(r.categories).toEqual(scanForSecrets(f.text));
    expect(covered(f.text, f.secret)).toBe(true);
  });

  it('covers the slack and stripe token bodies, not just the prefix', () => {
    const slack = 'x xoxb-123-456-abcdef y';
    expect(scanForSecretsWithRanges(slack).ranges).toEqual([{ start: 2, end: 21 }]);
    const stripe = 'x sk_live_ABCdef123 y';
    expect(scanForSecretsWithRanges(stripe).ranges).toEqual([{ start: 2, end: 19 }]);
  });

  // SEC-L1: every prefix category's span runs to the END of the token, so no
  // tail of the key (after a `_` or `-`) survives next to the sentinel.
  it.each([
    ['slack_token', 'xoxb-1234-5678-AbCdEf-gh'],
    ['stripe_secret_key', 'sk_live_AbCdEf0123456789xyz'],
    ['stripe_secret_key', 'rk_live_AbCdEf0123456789xyz'],
    ['openai_api_key', 'sk-AbCdEfGhIjKlMnOpQrSt'],
    ['openai_api_key', 'sk-AbCdEfGhIjKlMnOpQrSt_tail-more_end'],
  ])('%s span covers the whole token %s', (category, token) => {
    const text = `before ${token} after`;
    const r = scanForSecretsWithRanges(text);
    expect(r.categories).toContain(category);
    const start = text.indexOf(token);
    expect(r.ranges).toEqual([{ start, end: start + token.length }]);
  });

  it.each([
    ['openai_project_key', OPENAI_PROJECT_KEY],
    ['github_fine_grained_pat', GITHUB_FINE_GRAINED_PAT],
  ])('%s span covers the whole token (inner _ and - included)', (category, token) => {
    const text = `before ${token} after`;
    const r = scanForSecretsWithRanges(text);
    expect(r.categories).toEqual([category]);
    const start = text.indexOf(token);
    expect(r.ranges).toEqual([{ start, end: start + token.length }]);
  });

  it.each([
    `aws_secret_access_key = ${AWS_SECRET_VALUE}`,
    `secretAccessKey: "${AWS_SECRET_VALUE}"`,
  ])('aws_secret_access_key range covers the value only: %s', (assignment) => {
    const text = `cfg ${assignment} end`;
    const start = text.indexOf(AWS_SECRET_VALUE);
    expect(scanForSecretsWithRanges(text).ranges).toEqual([
      { start, end: start + AWS_SECRET_VALUE.length },
    ]);
  });

  it.each([
    `AWS secret access key ${AWS_SECRET_VALUE}`,
    `aws-secret-key:\t'${AWS_SECRET_VALUE}'`,
    `"SecretAccessKey": "${AWS_SECRET_VALUE}"`,
  ])('aws_secret_access_key range (capture group) covers the value only: %s', (assignment) => {
    const text = `cfg ${assignment} end`;
    const r = scanForSecretsWithRanges(text);
    expect(r.categories).toContain('aws_secret_access_key');
    const start = text.indexOf(AWS_SECRET_VALUE);
    expect(r.ranges).toEqual([{ start, end: start + AWS_SECRET_VALUE.length }]);
  });

  it('an AWS key pair: both the access key id and the bare secret get a span', () => {
    const text = `id ${AWS_ACCESS_KEY_ID} secret ${AWS_SECRET_VALUE} done`;
    const r = scanForSecretsWithRanges(text);
    expect(r.categories).toEqual(['aws_access_key_id', 'aws_secret_access_key']);
    const a = text.indexOf(AWS_ACCESS_KEY_ID);
    const s = text.indexOf(AWS_SECRET_VALUE);
    expect(r.ranges).toEqual([
      { start: a, end: a + AWS_ACCESS_KEY_ID.length },
      { start: s, end: s + AWS_SECRET_VALUE.length },
    ]);
  });

  it('a bare 40-char token without an access key id gets no span', () => {
    expect(scanForSecretsWithRanges(`sha ${AWS_SECRET_VALUE} ok`).ranges).toEqual([]);
  });

  it('an Anthropic-style key span covers the whole token', () => {
    const text = `before ${ANTHROPIC_STYLE_KEY} after`;
    const start = text.indexOf(ANTHROPIC_STYLE_KEY);
    expect(scanForSecretsWithRanges(text).ranges).toEqual([
      { start, end: start + ANTHROPIC_STYLE_KEY.length },
    ]);
  });

  it('the openai range only fires where the detector does (no "task-list" over-redaction)', () => {
    expect(scanForSecretsWithRanges('see the task-list and disk-usage notes').ranges).toEqual([]);
  });

  it('extends a PEM header to the END line', () => {
    const t = 'a\n-----BEGIN PRIVATE KEY-----\nQUJDREVGR0g=\n-----END PRIVATE KEY-----\nb';
    const [r] = scanForSecretsWithRanges(t).ranges;
    expect(t.slice(r!.start, r!.end)).toBe(
      '-----BEGIN PRIVATE KEY-----\nQUJDREVGR0g=\n-----END PRIVATE KEY-----',
    );
  });

  it('redacts an unterminated PEM block to the end of the text', () => {
    const t = 'see -----BEGIN EC PRIVATE KEY-----\nQUJDREVGR0g=';
    expect(scanForSecretsWithRanges(t).ranges).toEqual([{ start: 4, end: t.length }]);
  });

  it('finds two PEM blocks separately', () => {
    const block = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----';
    const t = `${block} and ${block}`;
    expect(scanForSecretsWithRanges(t).ranges).toEqual([
      { start: 0, end: block.length },
      { start: block.length + 5, end: t.length },
    ]);
  });

  it('assignment range covers the value only', () => {
    const t = 'password=abcdefghijklmnop rest';
    const [r] = scanForSecretsWithRanges(t).ranges;
    expect(t.slice(0, r!.start)).toBe('password=');
    expect(t.slice(r!.start, r!.end)).toBe('abcdefghijklmnop');
  });

  it('assignment split across a newline is detected but has no range', () => {
    const t = 'password:\n abcdefghijklmnop';
    const r = scanForSecretsWithRanges(t);
    expect(r.categories).toContain('secret_assignment');
    expect(r.ranges).toEqual([]);
  });

  it('merges overlapping spans (assignment + github token)', () => {
    const t = 'token=ghp_1234567890abcdefghij end';
    expect(scanForSecretsWithRanges(t).ranges).toEqual([{ start: 6, end: 30 }]);
  });

  it('merges adjacent spans', () => {
    const t = 'AKIAIOSFODNN7EXAMPLE -----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----';
    // The AWS key ends at 20; the PEM starts at 21 → two spans. Adjacent at 20 → one.
    expect(scanForSecretsWithRanges(t).ranges).toHaveLength(2);
    const adjacent = 'sk_live_abc-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----';
    expect(scanForSecretsWithRanges(adjacent).ranges).toEqual([{ start: 0, end: adjacent.length }]);
  });

  it('throws RangeError above 10_000 chars', () => {
    expect(() => scanForSecretsWithRanges('a'.repeat(10_001))).toThrow(RangeError);
  });

  it('is repeatable (no lastIndex leak between calls)', () => {
    const t = SECRET_FIXTURES.map((f) => f.text).join('\n');
    expect(scanForSecretsWithRanges(t)).toEqual(scanForSecretsWithRanges(t));
  });

  it('returns nothing for clean text', () => {
    expect(scanForSecretsWithRanges('A plain deploy note.')).toEqual({
      categories: [],
      ranges: [],
    });
  });
});
