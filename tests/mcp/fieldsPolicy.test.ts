/**
 * T025: fieldsPolicy unit tests.
 *
 * Covers:
 *  1. An allowed-key subset passes (no throw) for each representative memory type.
 *  2. An empty {} object passes for every type.
 *  3. An unknown key throws AppError(INVALID_REFERENCE) — opaque, no key leakage.
 *
 * Design ref: Decision 5, write-path design.md.
 * Policy: strict on shape, lenient on presence — every key present must be in the
 * allowed set for that type; missing keys are allowed; values are not deep-typed.
 */

import { describe, it, expect } from 'vitest';
import { assertValidFields } from '../../src/mcp/fieldsPolicy.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';

// ---------------------------------------------------------------------------
// Helper: assert that an error is AppError(INVALID_REFERENCE)
// ---------------------------------------------------------------------------

function expectInvalidReference(fn: () => void): void {
  expect(fn).toThrow(AppError);
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe(ErrorCode.INVALID_REFERENCE);
}

// ---------------------------------------------------------------------------
// 1. Allowed subset passes for representative types
// ---------------------------------------------------------------------------

describe('assertValidFields — allowed keys pass for each type', () => {
  it('decision: both allowed keys (alternatives, drivers)', () => {
    expect(() =>
      assertValidFields('decision', { alternatives: 'option A vs B', drivers: 'cost' }),
    ).not.toThrow();
  });

  it('decision: single allowed key (alternatives only)', () => {
    expect(() =>
      assertValidFields('decision', { alternatives: 'only one option considered' }),
    ).not.toThrow();
  });

  it('constraint: all three allowed keys (rule, scope, consequence)', () => {
    expect(() =>
      assertValidFields('constraint', {
        rule: 'no direct SQL string building',
        scope: 'all DB access layers',
        consequence: 'SQL injection prevention',
      }),
    ).not.toThrow();
  });

  it('gotcha: all three allowed keys (symptom, root_cause, fix)', () => {
    expect(() =>
      assertValidFields('gotcha', {
        symptom: 'connection pool exhaustion',
        root_cause: 'missing await on async query',
        fix: 'always await pg queries',
      }),
    ).not.toThrow();
  });

  it('pattern: both allowed keys (statement, applies_to)', () => {
    expect(() =>
      assertValidFields('pattern', {
        statement: 'use CQRS to separate reads from writes',
        applies_to: 'write-heavy services',
      }),
    ).not.toThrow();
  });

  it('integration_note: all three allowed keys (system, quirk, workaround)', () => {
    expect(() =>
      assertValidFields('integration_note', {
        system: 'Stripe',
        quirk: 'webhook events can arrive out of order',
        workaround: 'store event sequence number and deduplicate',
      }),
    ).not.toThrow();
  });

  it('domain_rule: both allowed keys (rule, enforced_in)', () => {
    expect(() =>
      assertValidFields('domain_rule', {
        rule: 'all timestamps stored in UTC',
        enforced_in: 'database layer via CHECK constraint',
      }),
    ).not.toThrow();
  });

  it('outcome: all three allowed keys (about, result, metrics)', () => {
    expect(() =>
      assertValidFields('outcome', {
        about: 'schema migration to v2',
        result: 'success; zero downtime',
        metrics: 'p99 latency 2 s, rollback time < 30 s',
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Empty {} passes for every type
// ---------------------------------------------------------------------------

describe('assertValidFields — empty fields object passes for every type', () => {
  const TYPES = [
    'decision',
    'constraint',
    'gotcha',
    'pattern',
    'integration_note',
    'domain_rule',
    'outcome',
  ] as const;

  for (const type of TYPES) {
    it(`${type}: empty {} does not throw`, () => {
      expect(() => assertValidFields(type, {})).not.toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Unknown key throws INVALID_REFERENCE
// ---------------------------------------------------------------------------

describe('assertValidFields — unknown key throws INVALID_REFERENCE', () => {
  it('decision: single unknown key', () => {
    expectInvalidReference(() =>
      assertValidFields('decision', { bogus_key: 'value' }),
    );
  });

  it('decision: unknown key mixed with a valid allowed key', () => {
    // Even one unknown key among valid keys should throw.
    expectInvalidReference(() =>
      assertValidFields('decision', { alternatives: 'ok', extra_field: 'bad' }),
    );
  });

  it('constraint: unknown key', () => {
    expectInvalidReference(() =>
      assertValidFields('constraint', { unknown_constraint_key: 'bad' }),
    );
  });

  it('gotcha: a key valid for a different type (cross-type contamination)', () => {
    // 'alternatives' is allowed on 'decision' but not on 'gotcha'
    expectInvalidReference(() =>
      assertValidFields('gotcha', { alternatives: 'this key belongs to decision' }),
    );
  });

  it('outcome: unknown key', () => {
    expectInvalidReference(() =>
      assertValidFields('outcome', { about: 'valid', evil: 'should be rejected' }),
    );
  });

  it('error message is opaque — does not reveal the unknown key name', () => {
    let caught: unknown;
    try {
      assertValidFields('decision', { evil_key_name: 'value' });
    } catch (err) {
      caught = err;
    }
    expect((caught as AppError).opaqueMessage).not.toContain('evil_key_name');
  });
});
