/**
 * piiMask unit tests (judge-structured-verdict C1, batch C).
 *
 * Positives per category, protected-span negatives (ids, handles, versions,
 * IPs, dates, ports), idempotency, field walking and bounds.
 */

import { describe, it, expect } from 'vitest';
import { maskPii, maskPiiInFields } from '../../src/security/piiMask.js';

describe('maskPii — positives', () => {
  it('masks emails', () => {
    const r = maskPii('Contact juan.perez+gmemo@example.co.uk for access.');
    expect(r.text).toBe('Contact [EMAIL] for access.');
    expect(r.categories).toEqual(['email']);
  });

  it('masks several emails in one text', () => {
    expect(maskPii('a@b.io and c.d@e-f.com').text).toBe('[EMAIL] and [EMAIL]');
  });

  it.each([
    '+54 11 4567-8901',
    '+54-9-11-4567-8901',
    '(011) 4567-8901',
    '11 4567 8901',
    '+34 612 345 678',
  ])('masks phone %j', (phone) => {
    const r = maskPii(`Call ${phone}`);
    expect(r.text).toBe('Call [PHONE]');
    expect(r.categories).toEqual(['phone']);
  });

  it('masks a phone at the end of a sentence', () => {
    expect(maskPii('Reach us at +54 11 4567-8901.').text).toBe('Reach us at [PHONE].');
  });

  it.each(['20-12345678-9', '27123456784', '30-71234567-0'])(
    'masks CUIT/CUIL %s as [ID]',
    (cuit) => {
      const r = maskPii(`CUIT ${cuit} registered`);
      expect(r.text).toBe('CUIT [ID] registered');
      expect(r.categories).toEqual(['national_id']);
    },
  );

  it.each(['12345678', '9876543'])('masks DNI %s as [ID]', (dni) => {
    const r = maskPii(`DNI ${dni}.`);
    expect(r.text).toBe('DNI [ID].');
    expect(r.categories).toEqual(['national_id']);
  });

  it('reports categories in processing order, deduplicated', () => {
    const r = maskPii('a@b.com, 12345678, 20-12345678-9, +54 11 4567-8901, 87654321');
    expect(r.text).toBe('[EMAIL], [ID], [ID], [PHONE], [ID]');
    expect(r.categories).toEqual(['email', 'national_id', 'phone']);
  });
});

describe('maskPii — negatives (protected spans and identifiers)', () => {
  it.each([
    ['UUID', 'id 3f2504e0-4f89-41d3-9a0c-0305e82c3301 stored'],
    ['seed id', 'seed 00000000-0000-0000-0000-000000000040 exists'],
    ['handle (base64url)', 'handle aG1lbTowYjk5ZTYxMi0xMjM0LTRhYmMtOWRlZi0xMjM0NTY3ODkwYWI6Mw ok'],
    ['ULID', 'session 01ARZ3NDEKTSV4RRFFQ69G5FAV open'],
    ['sha256', 'hash 8f16cbf2ee32965e7c98dd67924f17a9030f9ace8446fea9e247b3727d52e071 stored'],
    ['pnpm version', 'packageManager is pnpm@9.15.0'],
    ['scp git remote', 'clone git@github.com:org/repo.git'],
    ['IPv4', 'host 10.0.0.1 and 192.168.100.200'],
    ['semver', 'upgrade from 1.2.3 to 22.10.1'],
    ['ISO date', 'released 2026-11-07'],
    ['compact date', 'released 20261107'],
    ['ISO timestamp', 'at 2026-11-07T21:09:14.656Z'],
    ['port', 'postgres on port 5432'],
    ['short number', 'retry 3 times, timeout 3000 ms'],
    ['decimal', 'ratio 12345678.5 measured'],
    ['file path', 'see src/db/pool.ts line 120'],
    ['migration name', 'run 0007_judge_structured_verdict.sql'],
    ['13-digit epoch ms', 'ts 1699999999999'],
  ])('leaves %s untouched', (_name, text) => {
    const r = maskPii(text);
    expect(r.text).toBe(text);
    expect(r.categories).toEqual([]);
  });

  it('does not mask a number inside an opaque token even if it looks like a DNI', () => {
    const text = 'token AbCd12345678EfGh9012 end';
    expect(maskPii(text).text).toBe(text);
  });

  it('returns clean prose unchanged', () => {
    const text = 'The pool in src/db/pool.ts exhausts when max is 5.';
    expect(maskPii(text)).toEqual({ text, categories: [] });
  });
});

describe('maskPii — idempotency and bounds', () => {
  it('is idempotent: masking masked text changes nothing', () => {
    const once = maskPii('mail a@b.com dni 12345678 cuit 20-12345678-9 tel +54 11 4567-8901');
    const twice = maskPii(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.categories).toEqual([]);
  });

  it('returns empty result for empty text', () => {
    expect(maskPii('')).toEqual({ text: '', categories: [] });
  });

  it('throws a RangeError on oversize input (fail-closed)', () => {
    expect(() => maskPii('a'.repeat(10_001))).toThrow(RangeError);
  });

  it('runs in bounded time on adversarial input', () => {
    const inputs = [
      'a'.repeat(9000),
      'a.'.repeat(4500),
      '1 '.repeat(4500),
      '1-'.repeat(4500),
      '@'.repeat(9000),
      `${'a'.repeat(4500)}@${'b.'.repeat(2000)}`,
      '(1) '.repeat(2000),
    ];
    const start = performance.now();
    for (const input of inputs) maskPii(input);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('maskPiiInFields', () => {
  it('masks string leaves, never keys, and leaves non-strings alone', () => {
    const fields = {
      'owner@example.com': 'key stays',
      contact: 'ping a@b.com',
      nested: { list: ['DNI 12345678', 42, true, null], deep: { phone: '+54 11 4567-8901' } },
      count: 12345678,
    };
    const r = maskPiiInFields(fields);
    expect(r.fields).toEqual({
      'owner@example.com': 'key stays',
      contact: 'ping [EMAIL]',
      nested: { list: ['DNI [ID]', 42, true, null], deep: { phone: '[PHONE]' } },
      count: 12345678,
    });
    expect(r.categories).toEqual(['email', 'national_id', 'phone']);
  });

  it('does not mutate the input', () => {
    const fields = { a: { b: 'x@y.com' } };
    const snapshot = JSON.parse(JSON.stringify(fields));
    maskPiiInFields(fields);
    expect(fields).toEqual(snapshot);
  });

  it('returns an equal object and no categories for clean fields', () => {
    const fields = { severity: 'high', refs: ['src/a.ts'] };
    expect(maskPiiInFields(fields)).toEqual({ fields, categories: [] });
  });

  it('handles empty fields', () => {
    expect(maskPiiInFields({})).toEqual({ fields: {}, categories: [] });
  });

  it('is idempotent', () => {
    const once = maskPiiInFields({ c: 'a@b.com', n: ['12345678'] });
    const twice = maskPiiInFields(once.fields);
    expect(twice.fields).toEqual(once.fields);
    expect(twice.categories).toEqual([]);
  });

  it('throws a RangeError when nesting exceeds depth 4 (fail-closed, never leaves PII unmasked)', () => {
    const tooDeep = { a: { b: { c: { d: { e: 'x@y.com' } } } } };
    expect(() => maskPiiInFields(tooDeep)).toThrow(RangeError);
  });

  it('accepts nesting up to depth 4', () => {
    const ok = { a: { b: { c: { d: 'x@y.com' } } } };
    expect(maskPiiInFields(ok).fields).toEqual({ a: { b: { c: { d: '[EMAIL]' } } } });
  });
});
