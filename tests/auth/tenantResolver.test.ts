/**
 * T163: RdsTenantResolver — tenant resolution unit tests.
 *
 * Uses InMemoryAuthRepository so no real database is needed. Covers:
 *  - known X-Git-Remote → TenantContext with correct projectId / repoId / branch
 *  - supplied branch takes precedence over repo default_branch
 *  - missing branch falls back to repo default_branch
 *  - unknown remote URL → PERMISSION_DENIED
 *  - missing X-Git-Remote header → PERMISSION_DENIED
 */

import { describe, it, expect } from 'vitest';
import { RdsTenantResolver } from '../../src/auth/tenantResolver.js';
import { InMemoryAuthRepository } from './fakes.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';
import type { TenantResolutionInput } from '../../src/mcp/context.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_REMOTE = 'https://github.com/acme/api.git';
const REPO_ID = 'repo-uuid-001';
const PROJECT_ID = 'proj-uuid-001';
const DEFAULT_BRANCH = 'main';

const repo = new InMemoryAuthRepository(
  [{ remoteUrl: REPO_REMOTE, repoId: REPO_ID, projectId: PROJECT_ID, defaultBranch: DEFAULT_BRANCH }],
);

const resolver = new RdsTenantResolver(repo);

function makeInput(overrides: Partial<TenantResolutionInput> = {}): TenantResolutionInput {
  return {
    authorization: 'Bearer some-token',
    gitRemote: REPO_REMOTE,
    branch: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RdsTenantResolver — tenant resolution', () => {
  // --- Happy path ---

  it('returns TenantContext for a known remote URL', async () => {
    const ctx = await resolver.resolve(makeInput());

    expect(ctx.projectId).toBe(PROJECT_ID);
    expect(ctx.repoId).toBe(REPO_ID);
  });

  it('uses the supplied branch when provided', async () => {
    const ctx = await resolver.resolve(makeInput({ branch: 'feature/auth' }));

    expect(ctx.branch).toBe('feature/auth');
  });

  it('falls back to repo default_branch when no branch header is supplied', async () => {
    const ctx = await resolver.resolve(makeInput({ branch: undefined }));

    expect(ctx.branch).toBe(DEFAULT_BRANCH);
  });

  it('passes through an empty-string branch as-is (only undefined/null falls back to default)', async () => {
    // The resolver uses `??` (nullish coalescing) — it falls back only on null/undefined.
    // An empty string is treated as a supplied value, not absent. This documents the
    // implementation boundary; the transport layer will typically produce undefined (not '')
    // for a missing X-Git-Branch header, so this case is an edge condition.
    const ctx = await resolver.resolve(makeInput({ branch: '' }));

    expect(ctx.branch).toBe('');
  });

  // --- Denial paths ---

  it('throws PERMISSION_DENIED for an unknown remote URL', async () => {
    await expect(
      resolver.resolve(makeInput({ gitRemote: 'https://github.com/unknown/repo.git' })),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED when X-Git-Remote header is undefined', async () => {
    await expect(
      resolver.resolve(makeInput({ gitRemote: undefined })),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  it('throws PERMISSION_DENIED when X-Git-Remote header is empty string', async () => {
    await expect(
      resolver.resolve(makeInput({ gitRemote: '' })),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AppError && err.code === ErrorCode.PERMISSION_DENIED,
    );
  });

  // --- Opacity: unknown remote is indistinguishable from missing header ---

  it('unknown remote and missing header produce the same "Access denied." message', async () => {
    const unknownErr = await resolver
      .resolve(makeInput({ gitRemote: 'https://github.com/nobody/secret.git' }))
      .catch((e: unknown) => e);

    const missingErr = await resolver
      .resolve(makeInput({ gitRemote: undefined }))
      .catch((e: unknown) => e);

    expect(unknownErr).toBeInstanceOf(AppError);
    expect(missingErr).toBeInstanceOf(AppError);
    expect((unknownErr as AppError).opaqueMessage).toBe('Access denied.');
    expect((missingErr as AppError).opaqueMessage).toBe((unknownErr as AppError).opaqueMessage);
  });
});
