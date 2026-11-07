/**
 * T022 — POST /promote handler integration tests.
 *
 * All services are faked — no real DB. supertest (devDependency) drives the
 * Express app assembled via createApp() so the terminal error handler
 * (opacity model) is exercised for every denial scenario.
 *
 * Each test creates its own Express app instance to avoid shared state.
 *
 * Covered scenarios:
 *  1. Happy path: valid OIDC principal + matching repo + open session → 200 outcome.
 *  2. body.repo !== principal.repository → opaque 500, no body/tenant echo.
 *  3. No open session (findOpenSessionId → null) → 200 { status:'no_op', ... }.
 *  4. Unknown repo (findRepoByGithubSlug → null) → opaque 500.
 *  5. Malformed body (missing source_branch) → opaque 500, no schema echo.
 *  6. Malformed body (extra field rejected by .strict()) → opaque 500, no schema echo.
 *  7. Injected fault in promoteService.promote → opaque 500, no message/stack leakage.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/http/app.js';
import { makeStubAuthServices, InMemoryAuthRepository } from '../auth/fakes.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';
import type { PromoteOutcome } from '../../src/promote/promoteService.js';
import type { PromoteServiceLike } from '../../src/promote/promoteService.js';
import type { OidcVerifier } from '../../src/auth/oidcAuthenticator.js';
import type { PromotionRepository } from '../../src/db/promotionRepository.js';
import type { ActorIdentity, Authorizer, Principal, TenantContext, ToolName } from '../../src/mcp/context.js';
import type { PromotePrincipal } from '../../src/auth/oidcAuthenticator.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const OWNER_REPO = 'acme/billing';
const REMOTE_URL = `https://github.com/${OWNER_REPO}.git`;
const PROJECT_ID = 'proj-t022-001';
const REPO_ID = 'repo-t022-001';
const SESSION_ID = 'sess-t022-001';

/** Valid minimal body that satisfies the PromoteBody Zod schema.
 *
 * source_branch must equal the repo's default_branch for the promotion to be
 * allowed (FLAG #1 assertion in the handler: default-branch enforcement).
 */
const VALID_BODY = {
  repo: OWNER_REPO,
  source_branch: 'main',
};

/** Expected outcome for the happy-path test. */
const HAPPY_OUTCOME: PromoteOutcome = {
  status: 'promoted',
  applied: 1,
  deduped: 0,
  quarantined: 0,
  uncertain: 0,
};

/** Expected outcome when there is no open staging session. */
const NO_OP_OUTCOME: PromoteOutcome = {
  status: 'no_op',
  applied: 0,
  deduped: 0,
  quarantined: 0,
  uncertain: 0,
};

/** Generic opaque body returned by the terminal error handler for all errors. */
const OPAQUE_ERROR_BODY = { error: 'Internal server error' };

// ---------------------------------------------------------------------------
// Local fake builders (stateless — each call returns a fresh object)
// ---------------------------------------------------------------------------

/**
 * OidcVerifier that resolves with the given repository slug.
 * All real OIDC verification is bypassed.
 */
function makeOidcVerifier(repository: string, ref = 'refs/heads/main'): OidcVerifier {
  return {
    verify: async (_authorization) => ({
      repository,
      ref,
    }),
  };
}

/**
 * PromotionRepository whose findOpenSessionId returns the given session ID
 * (or null for the no-open-session case). All other methods are no-ops.
 */
function makePromotionRepo(sessionId: string | null): PromotionRepository {
  return {
    findOpenSessionId: async () => sessionId,
    fetchPromotableItems: async () => [],
    recordVerdict: async () => {},
    applyAccepted: async () => ({
      status: 'applied' as const,
      memoryId: 'mem-t022',
      deduped: false,
    }),
    quarantineItem: async () => {},
    finalizeSession: async () => {},
  };
}

/**
 * PromoteService that resolves with the scripted outcome.
 *
 * AppServices types this field as the concrete PromoteService class (which has
 * a private `deps` field). A duck-type cast is used here — this is standard
 * test practice for TypeScript classes with private members.
 */
function makeScriptedPromoteService(outcome: PromoteOutcome): PromoteServiceLike {
  return { promote: async () => outcome };
}

/**
 * PromoteService that always throws a recognisable sentinel error.
 * Tests use this to assert that the sentinel string never leaks to the caller.
 */
function makeThrowingPromoteService(): PromoteServiceLike {
  return {
    promote: async () => {
      throw new Error('promote-fault-sentinel-do-not-leak');
    },
  };
}

/**
 * Builds a full AppServices bag wired for the happy path.
 *
 * The InMemoryAuthRepository is seeded with the test repo so that
 * findRepoByGithubSlug('acme/billing') resolves correctly. Every other seam
 * is either the stub provided by makeStubAuthServices or the override below.
 */
function makeHappyServices(promoteOutcome: PromoteOutcome = HAPPY_OUTCOME) {
  const authRepository = new InMemoryAuthRepository([
    {
      remoteUrl: REMOTE_URL,
      repoId: REPO_ID,
      projectId: PROJECT_ID,
      defaultBranch: 'main',
    },
  ]);

  return makeStubAuthServices({
    oidcVerifier: makeOidcVerifier(OWNER_REPO),
    authRepository,
    promotionRepository: makePromotionRepo(SESSION_ID),
    promoteService: makeScriptedPromoteService(promoteOutcome),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /promote', () => {
  it('happy path: valid OIDC principal + matching repo + open session → 200 with PromoteOutcome', async () => {
    const app = createApp(makeHappyServices());

    const res = await request(app)
      .post('/promote')
      .set('Authorization', 'Bearer fake-oidc-token')
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(HAPPY_OUTCOME);
  });

  it('body.repo !== principal.repository → opaque 500, no body/tenant detail echoed', async () => {
    // OIDC principal claims a DIFFERENT repo than what the body submits.
    // The handler asserts equality and throws AppError(PERMISSION_DENIED).
    const services = makeStubAuthServices({
      oidcVerifier: makeOidcVerifier('other-org/other-repo'),
      authRepository: new InMemoryAuthRepository([
        {
          remoteUrl: REMOTE_URL,
          repoId: REPO_ID,
          projectId: PROJECT_ID,
          defaultBranch: 'main',
        },
      ]),
      promotionRepository: makePromotionRepo(SESSION_ID),
      promoteService: makeScriptedPromoteService(HAPPY_OUTCOME),
    });

    const app = createApp(services);
    const res = await request(app)
      .post('/promote')
      .set('Authorization', 'Bearer fake-oidc-token')
      .send(VALID_BODY);

    expect(res.status).toBe(500);
    // Exact body match — only the generic error field, nothing else.
    expect(res.body).toEqual(OPAQUE_ERROR_BODY);
    // Confirm neither the submitted repo slug nor the principal's repo appears.
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain(OWNER_REPO);
    expect(serialised).not.toContain('other-org');
    expect(serialised).not.toContain(PROJECT_ID);
    expect(serialised).not.toContain(REPO_ID);
  });

  it('no open session (findOpenSessionId → null) → 200 with no_op outcome', async () => {
    const authRepository = new InMemoryAuthRepository([
      {
        remoteUrl: REMOTE_URL,
        repoId: REPO_ID,
        projectId: PROJECT_ID,
        defaultBranch: 'main',
      },
    ]);

    const services = makeStubAuthServices({
      oidcVerifier: makeOidcVerifier(OWNER_REPO),
      authRepository,
      promotionRepository: makePromotionRepo(null), // null → no open session
      promoteService: makeScriptedPromoteService(HAPPY_OUTCOME),
    });

    const app = createApp(services);
    const res = await request(app)
      .post('/promote')
      .set('Authorization', 'Bearer fake-oidc-token')
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(NO_OP_OUTCOME);
  });

  it('unknown repo (findRepoByGithubSlug → null) → opaque 500', async () => {
    // Empty InMemoryAuthRepository — findRepoByGithubSlug returns null for any slug.
    const services = makeStubAuthServices({
      oidcVerifier: makeOidcVerifier(OWNER_REPO),
      authRepository: new InMemoryAuthRepository(), // no seeded repos
      promotionRepository: makePromotionRepo(SESSION_ID),
      promoteService: makeScriptedPromoteService(HAPPY_OUTCOME),
    });

    const app = createApp(services);
    const res = await request(app)
      .post('/promote')
      .set('Authorization', 'Bearer fake-oidc-token')
      .send(VALID_BODY);

    expect(res.status).toBe(500);
    expect(res.body).toEqual(OPAQUE_ERROR_BODY);
    // No slug, project or repo ID must appear in the response.
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain(OWNER_REPO);
    expect(serialised).not.toContain(PROJECT_ID);
    expect(serialised).not.toContain(REPO_ID);
  });

  it('malformed body (missing source_branch) → opaque 500, no Zod/schema detail echoed', async () => {
    const app = createApp(makeHappyServices());

    const res = await request(app)
      .post('/promote')
      .set('Authorization', 'Bearer fake-oidc-token')
      .send({ repo: OWNER_REPO }); // source_branch intentionally omitted

    expect(res.status).toBe(500);
    expect(res.body).toEqual(OPAQUE_ERROR_BODY);
    // Schema field names and Zod error strings must not appear.
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('source_branch');
    expect(serialised).not.toContain('Required');
    expect(serialised).not.toContain('ZodError');
    expect(serialised).not.toContain('issues');
  });

  it('malformed body (extra field rejected by .strict()) → opaque 500, no schema echo', async () => {
    const app = createApp(makeHappyServices());

    const res = await request(app)
      .post('/promote')
      .set('Authorization', 'Bearer fake-oidc-token')
      .send({ ...VALID_BODY, unknown_extra_field: 'surprise' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual(OPAQUE_ERROR_BODY);
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('unknown_extra_field');
    expect(serialised).not.toContain('unrecognized_keys');
    expect(serialised).not.toContain('ZodError');
  });

  // H1: OIDC ref claim enforcement — ref mismatch → opaque denial
  it('ref claim mismatch: canonicalized principal.ref ≠ body.source_branch → opaque 500, no branch name echoed (H1)', async () => {
    // OIDC token claims 'refs/heads/deploy/prod' but body requests source_branch='feature/billing-dispatch'.
    // After canonicalization ('deploy/prod' ≠ 'feature/billing-dispatch') → PERMISSION_DENIED.
    const services = makeStubAuthServices({
      oidcVerifier: {
        verify: async (_authorization) => ({
          repository: OWNER_REPO,
          ref: 'refs/heads/deploy/prod',
        }),
      },
      authRepository: new InMemoryAuthRepository([
        {
          remoteUrl: REMOTE_URL,
          repoId: REPO_ID,
          projectId: PROJECT_ID,
          defaultBranch: 'main',
        },
      ]),
      promotionRepository: makePromotionRepo(SESSION_ID),
      promoteService: makeScriptedPromoteService(HAPPY_OUTCOME),
    });

    const app = createApp(services);
    const res = await request(app)
      .post('/promote')
      .set('Authorization', 'Bearer fake-oidc-token')
      .send({ repo: OWNER_REPO, source_branch: 'feature/billing-dispatch' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual(OPAQUE_ERROR_BODY);
    // Neither branch name must appear in the response (no oracle)
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('deploy/prod');
    expect(serialised).not.toContain('billing-dispatch');
    expect(serialised).not.toContain(PROJECT_ID);
  });

  // M2: authorizer denial → opaque error
  it('OIDC ok + repo resolves but authorizePromote denies → opaque 500 (M2)', async () => {
    const authRepository = new InMemoryAuthRepository([
      {
        remoteUrl: REMOTE_URL,
        repoId: REPO_ID,
        projectId: PROJECT_ID,
        defaultBranch: 'main',
      },
    ]);

    // Custom authorizer that passes the Cognito path but denies authorizePromote
    const denyingAuthorizer: Authorizer = {
      authorize: (_principal: Principal, _tenant: TenantContext, _tool: ToolName): Promise<ActorIdentity> =>
        Promise.resolve({ actorId: 'stub', roles: ['viewer'] }),
      authorizePromote: (_principal: PromotePrincipal, _tenant: TenantContext): Promise<ActorIdentity> => {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      },
    };

    const services = makeStubAuthServices({
      oidcVerifier: makeOidcVerifier(OWNER_REPO),
      authRepository,
      authorizer: denyingAuthorizer,
      promotionRepository: makePromotionRepo(SESSION_ID),
      promoteService: makeScriptedPromoteService(HAPPY_OUTCOME),
    });

    const app = createApp(services);
    const res = await request(app)
      .post('/promote')
      .set('Authorization', 'Bearer fake-oidc-token')
      .send(VALID_BODY);

    expect(res.status).toBe(500);
    expect(res.body).toEqual(OPAQUE_ERROR_BODY);
    // No credential detail, project ID, or repository must appear
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain(OWNER_REPO);
    expect(serialised).not.toContain(PROJECT_ID);
  });

  // FLAG #1: default-branch enforcement — feature branch → denied
  it('source_branch is a feature branch (≠ default_branch) → opaque 500, no branch detail echoed (FLAG#1)', async () => {
    // The OIDC token's ref and source_branch both say 'feature/bill-42' (ref check passes),
    // but the repo's default_branch is 'main' → default-branch assertion denies.
    const services = makeStubAuthServices({
      oidcVerifier: makeOidcVerifier(OWNER_REPO, 'refs/heads/feature/bill-42'),
      authRepository: new InMemoryAuthRepository([
        {
          remoteUrl: REMOTE_URL,
          repoId: REPO_ID,
          projectId: PROJECT_ID,
          defaultBranch: 'main',
        },
      ]),
      promotionRepository: makePromotionRepo(SESSION_ID),
      promoteService: makeScriptedPromoteService(HAPPY_OUTCOME),
    });

    const app = createApp(services);
    const res = await request(app)
      .post('/promote')
      .set('Authorization', 'Bearer fake-oidc-token')
      .send({ repo: OWNER_REPO, source_branch: 'feature/bill-42' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual(OPAQUE_ERROR_BODY);
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('feature');
    expect(serialised).not.toContain(PROJECT_ID);
  });

  // FLAG #1: default-branch happy path — source_branch == default_branch
  it('source_branch == default_branch AND valid OIDC → 200 (FLAG#1 happy path)', async () => {
    const app = createApp(makeHappyServices());

    const res = await request(app)
      .post('/promote')
      .set('Authorization', 'Bearer fake-oidc-token')
      .send(VALID_BODY); // source_branch: 'main' == defaultBranch: 'main'

    expect(res.status).toBe(200);
    expect(res.body).toEqual(HAPPY_OUTCOME);
  });

  it('injected fault in promoteService.promote → opaque 500, no error message or stack leakage', async () => {
    const authRepository = new InMemoryAuthRepository([
      {
        remoteUrl: REMOTE_URL,
        repoId: REPO_ID,
        projectId: PROJECT_ID,
        defaultBranch: 'main',
      },
    ]);

    const services = makeStubAuthServices({
      oidcVerifier: makeOidcVerifier(OWNER_REPO),
      authRepository,
      promotionRepository: makePromotionRepo(SESSION_ID),
      promoteService: makeThrowingPromoteService(),
    });

    const app = createApp(services);
    const res = await request(app)
      .post('/promote')
      .set('Authorization', 'Bearer fake-oidc-token')
      .send(VALID_BODY);

    expect(res.status).toBe(500);
    expect(res.body).toEqual(OPAQUE_ERROR_BODY);
    // The sentinel error message must not appear in the response.
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('promote-fault-sentinel-do-not-leak');
    expect(serialised).not.toContain('stack');
    expect(serialised).not.toContain('message');
  });
});
