/**
 * T024: secretScan unit tests.
 *
 * Covers:
 *  1. A positive detection case for each pattern category.
 *  2. Clean prose returns no findings (empty array from scanForSecrets).
 *  3. assertNoSecrets throws AppError(PERMISSION_DENIED) on any finding.
 *  4. The logger spy verifies that only category names are logged — the matched
 *     secret text never appears in any logger.warn call argument.
 *
 * Design ref: Decision 2, write-path design.md.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scanForSecrets, assertNoSecrets } from '../../src/security/secretScan.js';
import { logger } from '../../src/observability/logger.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';

// ---------------------------------------------------------------------------
// 1. Positive detection per category
// ---------------------------------------------------------------------------

describe('scanForSecrets — positive detection per category', () => {
  it('detects aws_access_key_id with AKIA prefix', () => {
    // AKIA + 16 uppercase A-Z0-9 chars
    expect(scanForSecrets('Key: AKIAIOSFODNN7EXAMPLE')).toContain('aws_access_key_id');
  });

  it('detects aws_access_key_id with ASIA prefix', () => {
    // ASIA prefix (session tokens) — same 16-char suffix rule
    expect(scanForSecrets('ASIAIOSFODNN7EXAMPLE used here')).toContain('aws_access_key_id');
  });

  it('detects pem_private_key (RSA header block)', () => {
    expect(scanForSecrets('-----BEGIN RSA PRIVATE KEY-----')).toContain('pem_private_key');
  });

  it('detects pem_private_key (EC PRIVATE KEY header)', () => {
    expect(scanForSecrets('-----BEGIN EC PRIVATE KEY-----')).toContain('pem_private_key');
  });

  it('detects jwt (header.payload.signature form)', () => {
    // Valid base64url-encoded header + payload + non-empty signature
    const jwt =
      'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.c2lnbmF0dXJl';
    expect(scanForSecrets(jwt)).toContain('jwt');
  });

  it('detects github_token (ghp_ PAT form)', () => {
    // gh + scope char (p=PAT) + _ + 20 alphanums
    expect(scanForSecrets('ghp_1234567890abcdefghij')).toContain('github_token');
  });

  it('detects github_token (ghs_ server token form)', () => {
    expect(scanForSecrets('ghs_abcdefghijklmnopqrst')).toContain('github_token');
  });

  it('detects slack_token (xoxb- bot token)', () => {
    expect(scanForSecrets('Bot token: xoxb-my-slack-bot-token')).toContain('slack_token');
  });

  it('detects slack_token (xoxa- app token)', () => {
    expect(scanForSecrets('xoxa-workspace-token-value')).toContain('slack_token');
  });

  it('detects google_api_key (AIza prefix + 35 chars)', () => {
    // AIza + exactly 35 [0-9A-Za-z_-] chars
    expect(
      scanForSecrets('AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI'),
    ).toContain('google_api_key');
  });

  it('detects stripe_secret_key (sk_live_ form)', () => {
    expect(scanForSecrets('sk_live_testkey123')).toContain('stripe_secret_key');
  });

  it('detects stripe_secret_key (rk_live_ restricted key form)', () => {
    expect(scanForSecrets('rk_live_restrictedkey456')).toContain('stripe_secret_key');
  });

  it('detects openai_api_key (sk- prefix + 20+ alphanums)', () => {
    // sk- (hyphen, not underscore) distinguishes OpenAI from Stripe
    expect(scanForSecrets('sk-abcdefghijklmnopqrstu')).toContain('openai_api_key');
  });

  it('detects secret_assignment generic heuristic (password= form)', () => {
    // 'password' keyword + '=' + 12+ non-whitespace chars
    expect(scanForSecrets('password=supersecretvalue99')).toContain('secret_assignment');
  });

  it('detects secret_assignment generic heuristic (TOKEN= form, case-insensitive)', () => {
    expect(scanForSecrets('TOKEN=abcdef1234567890XYZ')).toContain('secret_assignment');
  });

  it('detects secret_assignment generic heuristic (api_key: form)', () => {
    expect(scanForSecrets('api_key: someverylongsecretval')).toContain('secret_assignment');
  });
});

// ---------------------------------------------------------------------------
// 2. Clean prose returns no findings
// ---------------------------------------------------------------------------

describe('scanForSecrets — clean prose returns no findings', () => {
  it('returns an empty array for ordinary technical prose', () => {
    const prose =
      'Use a write-through caching strategy to keep the store consistent. ' +
      'Invalidate entries on every write operation. Results expire after 5 minutes.';
    expect(scanForSecrets(prose)).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(scanForSecrets('')).toEqual([]);
  });

  it('returns an empty array for a short identifier that looks similar but is not a secret', () => {
    // "sk-short" is only 8 chars after "sk-", below the 20-char minimum for openai_api_key
    expect(scanForSecrets('sk-short')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. assertNoSecrets throws PERMISSION_DENIED on any finding
// ---------------------------------------------------------------------------

describe('assertNoSecrets — throws PERMISSION_DENIED on a finding', () => {
  it('throws AppError(PERMISSION_DENIED) when a secret is present', () => {
    expect(() => assertNoSecrets('AKIAIOSFODNN7EXAMPLE')).toThrow(AppError);
  });

  it('thrown error has code PERMISSION_DENIED', () => {
    let caught: unknown;
    try {
      assertNoSecrets('AKIAIOSFODNN7EXAMPLE');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('does not throw for clean prose', () => {
    expect(() =>
      assertNoSecrets('The handler validates all inputs before persisting.'),
    ).not.toThrow();
  });

  it('throws when a secret is in any one of multiple parts', () => {
    // The secret spans only the second part — all parts are joined before scanning.
    expect(() =>
      assertNoSecrets('safe title', 'AKIAIOSFODNN7EXAMPLE', 'safe body'),
    ).toThrow(AppError);
  });

  it('throws for a JWT spread across the concatenated text', () => {
    const jwt =
      'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.c2lnbmF0dXJl';
    expect(() => assertNoSecrets(jwt)).toThrow(AppError);
  });
});

// ---------------------------------------------------------------------------
// 5. Fail-closed on internal error (REQ-21)
// ---------------------------------------------------------------------------

describe('assertNoSecrets — fail-closed on internal error', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws PERMISSION_DENIED when an internal step throws an unexpected error', () => {
    // Pass an argument whose toString() throws — this simulates an unexpected
    // internal failure during string assembly. The catch block in assertNoSecrets
    // treats any non-AppError throw as a positive finding (fail-closed) and
    // throws PERMISSION_DENIED so unscanned content is never persisted.
    const throwingArg = {
      toString: () => {
        throw new Error('unexpected internal scan failure');
      },
    };

    let caught: unknown;
    try {
      assertNoSecrets(throwingArg as unknown as string);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('still throws PERMISSION_DENIED (not the raw internal error) so no impl details leak', () => {
    const throwingArg = {
      toString: () => {
        throw new TypeError('regex engine failure');
      },
    };

    expect(() => assertNoSecrets(throwingArg as unknown as string)).toThrow(AppError);
    // The thrown error must not be the raw TypeError
    let caught: unknown;
    try {
      assertNoSecrets(throwingArg as unknown as string);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as AppError).code).toBe(ErrorCode.PERMISSION_DENIED);
  });
});

// ---------------------------------------------------------------------------
// 4. Logger spy — categories only, never the matched secret text
// ---------------------------------------------------------------------------

describe('assertNoSecrets — logger.warn logs category names only', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls logger.warn when a finding is detected', () => {
    const warnSpy = vi.mocked(logger.warn);
    try {
      assertNoSecrets('AKIAIOSFODNN7EXAMPLE');
    } catch {
      // expected throw
    }
    expect(warnSpy).toHaveBeenCalled();
  });

  it('logger.warn data includes the detected category name', () => {
    const warnSpy = vi.mocked(logger.warn);
    try {
      assertNoSecrets('AKIAIOSFODNN7EXAMPLE');
    } catch {
      // expected throw
    }
    // Serialize the full call record and check the category name is present
    const callsJson = JSON.stringify(warnSpy.mock.calls);
    expect(callsJson).toContain('aws_access_key_id');
  });

  it('logger.warn call arguments never contain the matched AWS key text', () => {
    const warnSpy = vi.mocked(logger.warn);
    const secretValue = 'AKIAIOSFODNN7EXAMPLE';
    try {
      assertNoSecrets(secretValue);
    } catch {
      // expected throw
    }
    const callsJson = JSON.stringify(warnSpy.mock.calls);
    expect(callsJson).not.toContain(secretValue);
  });

  it('logger.warn call arguments never contain the matched JWT text', () => {
    const warnSpy = vi.mocked(logger.warn);
    const jwt =
      'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.c2lnbmF0dXJl';
    try {
      assertNoSecrets(jwt);
    } catch {
      // expected throw
    }
    const callsJson = JSON.stringify(warnSpy.mock.calls);
    expect(callsJson).not.toContain(jwt);
  });

  it('logger.warn call arguments never contain the matched GitHub token text', () => {
    const warnSpy = vi.mocked(logger.warn);
    const token = 'ghp_1234567890abcdefghij';
    try {
      assertNoSecrets(token);
    } catch {
      // expected throw
    }
    const callsJson = JSON.stringify(warnSpy.mock.calls);
    expect(callsJson).not.toContain(token);
  });
});
