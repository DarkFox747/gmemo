/**
 * DevAuthenticator — Gate-1 dev stub unit tests.
 *
 * Covers the C2 dev-user seam (design D1):
 *  - header absent (opts.devUser undefined) → DEV_PRINCIPAL, Authorization ignored
 *  - known enabled email (case-insensitive, trimmed) → that user's idp_subject
 *  - unknown, disabled, malformed or empty email → PERMISSION_DENIED, byte-identical
 *  - constructor and authenticate() refuse under NODE_ENV=production
 */

import { describe, it, expect, afterEach } from 'vitest';
import { DevAuthenticator, DEV_PRINCIPAL } from '../../src/auth/devAuthenticator.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';
import { InMemoryAuthRepository } from './fakes.js';

const USERS = [
  { subject: 'demo-tl', userId: 'u-tl', globalRole: null, email: 'tl@demo.local' },
  {
    subject: 'demo-off',
    userId: 'u-off',
    globalRole: null,
    email: 'off@demo.local',
    disabled: true,
  },
];

function makeAuth(): DevAuthenticator {
  return new DevAuthenticator(new InMemoryAuthRepository([], USERS));
}

async function denialMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCode.PERMISSION_DENIED);
    return (err as AppError).message;
  }
  throw new Error('expected a denial');
}

describe('DevAuthenticator — default principal (header absent)', () => {
  const auth = makeAuth();

  it('returns DEV_PRINCIPAL when the Authorization header is undefined', async () => {
    await expect(auth.authenticate(undefined)).resolves.toEqual(DEV_PRINCIPAL);
  });

  it('ignores the Authorization header (well-formed or garbage)', async () => {
    await expect(auth.authenticate('Bearer valid-looking-token-abc123')).resolves.toEqual(
      DEV_PRINCIPAL,
    );
    await expect(auth.authenticate('garbage-not-a-real-header!!')).resolves.toEqual(DEV_PRINCIPAL);
  });

  it('returns DEV_PRINCIPAL when opts is given but devUser is undefined', async () => {
    await expect(auth.authenticate(undefined, {})).resolves.toEqual(DEV_PRINCIPAL);
  });

  it('DEV_PRINCIPAL has the exact fixed shape required by the seed and RBAC', () => {
    expect(DEV_PRINCIPAL.subject).toBe('dev-local-user');
    expect(DEV_PRINCIPAL.clientId).toBe('dev-local-client');
    expect(DEV_PRINCIPAL.scopes).toEqual(['gmemo.memory/read']);
  });
});

describe('DevAuthenticator — dev user selection', () => {
  const auth = makeAuth();

  it('resolves a known enabled email to that user subject', async () => {
    await expect(auth.authenticate(undefined, { devUser: 'tl@demo.local' })).resolves.toEqual({
      subject: 'demo-tl',
      clientId: 'dev-local-client',
      scopes: DEV_PRINCIPAL.scopes,
    });
  });

  it('matches case-insensitively and trims whitespace', async () => {
    const p = await auth.authenticate(undefined, { devUser: '  TL@Demo.Local ' });
    expect(p.subject).toBe('demo-tl');
  });

  it('denies unknown, disabled, malformed and empty emails with identical errors', async () => {
    const inputs = [
      'nobody@demo.local',
      'off@demo.local',
      'not-an-email',
      '',
      '   ',
      `${'a'.repeat(250)}@x.io`,
    ];
    const messages = await Promise.all(
      inputs.map((devUser) => denialMessage(auth.authenticate(undefined, { devUser }))),
    );
    expect(new Set(messages).size).toBe(1);
  });

  it('maps a repository failure to PERMISSION_DENIED', async () => {
    const failing = new DevAuthenticator({
      findEnabledUserByEmail: () => Promise.reject(new Error('db down')),
    });
    await denialMessage(failing.authenticate(undefined, { devUser: 'tl@demo.local' }));
  });
});

describe('DevAuthenticator — production refusal', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it('refuses to construct under NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => makeAuth()).toThrow();
  });

  it('refuses to authenticate under NODE_ENV=production even if already constructed', async () => {
    const auth = makeAuth();
    process.env.NODE_ENV = 'production';
    await denialMessage(auth.authenticate(undefined));
    await denialMessage(auth.authenticate(undefined, { devUser: 'tl@demo.local' }));
  });
});
