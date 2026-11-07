/**
 * T340: DevAuthenticator — Gate-1 stub unit tests.
 *
 * Verifies that DevAuthenticator returns the fixed DEV_PRINCIPAL for any
 * (or absent) Authorization header, without contacting Cognito or any
 * network endpoint. This is the dev-bypass Gate-1 implementation.
 *
 * NOTE: src/auth/devAuthenticator.ts is written by Group A in parallel.
 * If the module cannot be resolved at run time, these tests will fail with
 * ERR_MODULE_NOT_FOUND — that is the expected pending-install / parallel
 * group state, not a test bug.
 */

import { describe, it, expect } from 'vitest';
import { DevAuthenticator, DEV_PRINCIPAL } from '../../src/auth/devAuthenticator.js';

describe('DevAuthenticator', () => {
  const auth = new DevAuthenticator();

  it('returns DEV_PRINCIPAL when the Authorization header is undefined', async () => {
    const principal = await auth.authenticate(undefined);
    expect(principal).toEqual(DEV_PRINCIPAL);
  });

  it('returns DEV_PRINCIPAL for a well-formed Bearer header (arg ignored)', async () => {
    const principal = await auth.authenticate('Bearer valid-looking-token-abc123');
    expect(principal).toEqual(DEV_PRINCIPAL);
  });

  it('returns DEV_PRINCIPAL for a garbage header (arg ignored)', async () => {
    const principal = await auth.authenticate('garbage-not-a-real-header!!');
    expect(principal).toEqual(DEV_PRINCIPAL);
  });

  it('DEV_PRINCIPAL has the exact fixed shape required by the seed and RBAC', () => {
    // subject must equal app_user.idp_subject in migrations/seed.dev.sql
    expect(DEV_PRINCIPAL.subject).toBe('dev-local-user');
    // clientId is representative; Gate 2 / RBAC do not consume it
    expect(DEV_PRINCIPAL.clientId).toBe('dev-local-client');
    // scopes are representative; RdsAuthorizer derives roles from RDS, not from token claims
    expect(DEV_PRINCIPAL.scopes).toEqual(['lpms.memory/read']);
  });

  it('never throws — both a valid-looking and a garbage header resolve', async () => {
    await expect(auth.authenticate(undefined)).resolves.toEqual(DEV_PRINCIPAL);
    await expect(auth.authenticate('Bearer anything')).resolves.toEqual(DEV_PRINCIPAL);
  });
});
