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
 *  8. HU-04.2 closed_unmerged: discard, repeat no_op, promoted rows kept, and the
 *     PR-bound OIDC ref rules (C1–C4) all deny opaquely.
 *  9. HU-04.1 merged PR: default-branch token promotes the feature session with
 *     origin branch/PR; feature source without pr_number or non-default token denied.
 */

import { describe, it, expect, vi } from 'vitest';
import { logger } from '../../src/observability/logger.js';
import request from 'supertest';
import { createApp } from '../../src/http/app.js';
import { makeStubAuthServices, InMemoryAuthRepository } from '../auth/fakes.js';
import { AppError, ErrorCode } from '../../src/errors/appError.js';
import type { PromoteOutcome } from '../../src/promote/promoteService.js';
import type { PromoteServiceLike } from '../../src/promote/promoteService.js';
import type { OidcVerifier } from '../../src/auth/oidcAuthenticator.js';
import type { PromotionRepository } from '../../src/db/promotionRepository.js';
import type {
  ActorIdentity,
  AdminActor,
  ProjectMember,
  AuthenticatedUser,
  Authorizer,
  Principal,
  RequestContext,
  TenantContext,
  ToolName,
} from '../../src/mcp/context.js';
import type { OidcVerifyOptions, PromotePrincipal } from '../../src/auth/oidcAuthenticator.js';
import { DevOidcAuthenticator } from '../../src/auth/devOidcAuthenticator.js';
import { FakePromotionRepository, makeItem } from '../promote/fakes.js';

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
function makeOidcVerifier(
  repository: string,
  ref = 'refs/heads/main',
  headRef: string | null = null,
  extra: Partial<PromotePrincipal> = {},
): OidcVerifier {
  return {
    verify: async (_authorization) => ({
      repository,
      ref,
      headRef,
      // Default: the post-merge push run of promote.yml on the default branch.
      eventName: 'push',
      jobWorkflowRef: `${repository}/.github/workflows/promote.yml@refs/heads/main`,
      ...extra,
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
    findJudgeContext: async () => [],
    persistMasked: async () => 'ok' as const,
    recordDecision: async () => {},
    applyAccepted: async () => ({
      status: 'applied' as const,
      memoryId: 'mem-t022',
      deduped: false,
    }),
    quarantineItem: async () => 'q-t022',
    finalizeSession: async () => {},
    approveReviewItem: async () => ({
      status: 'approved' as const,
      memoryId: 'mem-t022',
      deduped: false,
      rebasedFromRevision: null,
      rebasedToRevision: null,
      relatedSuperseded: false,
    }),
    rejectReviewItem: async () => 'rejected' as const,
    abandonOpenSession: async () => ({ abandoned: true, discarded: 0 }),
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

  // H1: OIDC ref claim enforcement — token not minted on the default branch → opaque denial
  it('ref claim is not the default branch → opaque 500, no branch name echoed (H1)', async () => {
    // OIDC token claims 'refs/heads/deploy/prod' (not refs/heads/main) → PERMISSION_DENIED,
    // whatever the source_branch and even with a pr_number.
    const services = makeStubAuthServices({
      oidcVerifier: {
        verify: async (_authorization) => ({
          repository: OWNER_REPO,
          ref: 'refs/heads/deploy/prod',
          headRef: null,
          eventName: 'push',
          jobWorkflowRef: `${OWNER_REPO}/.github/workflows/promote.yml@refs/heads/deploy/prod`,
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
      .send({ repo: OWNER_REPO, source_branch: 'feature/billing-dispatch', pr_number: 3 });

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
      authorize: (
        _principal: Principal,
        _tenant: TenantContext,
        _tool: ToolName,
      ): Promise<ActorIdentity> =>
        Promise.resolve({ actorId: 'stub', userId: null, roles: ['viewer'] }),
      authorizePromote: (
        _principal: PromotePrincipal,
        _tenant: TenantContext,
      ): Promise<ActorIdentity> => {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      },
      authorizeUser: (_principal: Principal): Promise<AuthenticatedUser> => {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      },
      authorizeProjectAdmin: (_principal: Principal, _projectId: string): Promise<AdminActor> => {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      },
      authorizeProjectMember: (
        _principal: Principal,
        _projectId: string,
      ): Promise<ProjectMember> => {
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

  // Feature source without a PR number: the merged event can only promote a
  // feature session when it is bound to the merged PR.
  it('feature source_branch without pr_number (default-branch token) → opaque 500, no branch detail echoed', async () => {
    const services = makeStubAuthServices({
      oidcVerifier: makeOidcVerifier(OWNER_REPO, 'refs/heads/main'),
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

// ---------------------------------------------------------------------------
// HU-04.2 — closed_unmerged
// ---------------------------------------------------------------------------

/** FakePromotionRepository reports this id as the single open session. */
const FAKE_SESSION_ID = 'test-session';
const FEATURE = 'feature/x';
const PR = 7;
const CLOSED_BODY = {
  repo: OWNER_REPO,
  source_branch: FEATURE,
  pr_number: PR,
  event: 'closed_unmerged',
};

interface ClosedSetup {
  principal?: Partial<PromotePrincipal>;
  repo?: FakePromotionRepository;
  authorizer?: Authorizer;
  seedRepo?: boolean;
}

/**
 * Services for the closed_unmerged path: stateful FakePromotionRepository
 * seeded with 3 unpromoted items, PR-bound principal by default, and an audit
 * logger that captures recordAbandon calls.
 */
function makeClosedServices(setup: ClosedSetup = {}) {
  const repo =
    setup.repo ?? new FakePromotionRepository([makeItem('i1'), makeItem('i2'), makeItem('i3')]);
  const principal: PromotePrincipal = {
    repository: OWNER_REPO,
    ref: `refs/pull/${PR}/merge`,
    headRef: FEATURE,
    eventName: 'pull_request',
    jobWorkflowRef: `${OWNER_REPO}/.github/workflows/promote.yml@refs/pull/${PR}/merge`,
    ...setup.principal,
  };
  const verifyOpts: Array<OidcVerifyOptions | undefined> = [];
  const abandonAudits: Array<{
    ctx: RequestContext;
    p: { sessionId: string; discarded: number; prNumber: number };
  }> = [];

  const base = makeStubAuthServices();
  const services = makeStubAuthServices({
    oidcVerifier: {
      verify: async (_authorization, opts) => {
        verifyOpts.push(opts);
        return principal;
      },
    },
    authRepository: new InMemoryAuthRepository(
      setup.seedRepo === false
        ? []
        : [
            {
              remoteUrl: REMOTE_URL,
              repoId: REPO_ID,
              projectId: PROJECT_ID,
              defaultBranch: 'main',
            },
          ],
    ),
    promotionRepository: repo,
    promoteService: makeThrowingPromoteService(), // closed_unmerged must never promote
    auditLogger: {
      ...base.auditLogger,
      recordAbandon: async (ctx, p) => {
        abandonAudits.push({ ctx, p });
      },
    },
    ...(setup.authorizer ? { authorizer: setup.authorizer } : {}),
  });
  return { services, repo, verifyOpts, abandonAudits };
}

function postPromote(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
  return request(app).post('/promote').set('Authorization', 'Bearer fake-oidc-token').send(body);
}

describe('POST /promote — closed_unmerged (HU-04.2)', () => {
  it('3 staged items on feature/x → 200 {abandoned, discarded:3}, items gone, audit recorded', async () => {
    const { services, repo, abandonAudits } = makeClosedServices();

    const res = await postPromote(createApp(services), CLOSED_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'abandoned', discarded: 3 });
    expect(repo.abandonCalls).toEqual([{ sessionId: FAKE_SESSION_ID, projectId: PROJECT_ID }]);
    expect(repo.rows.size).toBe(0);
    expect(abandonAudits).toHaveLength(1);
    expect(abandonAudits[0].ctx.tenant).toEqual({
      projectId: PROJECT_ID,
      repoId: REPO_ID,
      branch: FEATURE,
    });
    expect(abandonAudits[0].p).toEqual({ sessionId: FAKE_SESSION_ID, discarded: 3, prNumber: PR });
  });

  it('audit failure after a committed abandon is logged (session id) and fails closed', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      const { services } = makeClosedServices();
      services.auditLogger.recordAbandon = () => Promise.reject(new Error('db down'));

      const res = await postPromote(createApp(services), CLOSED_BODY);

      expect(res.status).toBe(500);
      expect(spy.mock.calls.some((c) => JSON.stringify(c).includes(FAKE_SESSION_ID))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('repeated close → 200 no_op with discarded 0 and no second audit', async () => {
    const { services, abandonAudits } = makeClosedServices();
    const app = createApp(services);

    await postPromote(app, CLOSED_BODY);
    const res = await postPromote(app, CLOSED_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'no_op', discarded: 0 });
    expect(abandonAudits).toHaveLength(1);
  });

  it('promoted rows are kept; only non-promoted items are discarded', async () => {
    const repo = new FakePromotionRepository([
      makeItem('i1'),
      makeItem('i2'),
      makeItem('p1', { promoted_at: new Date(), promoted_memory_id: 'mem-1' }),
    ]);
    const { services } = makeClosedServices({ repo });

    const res = await postPromote(createApp(services), CLOSED_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'abandoned', discarded: 2 });
    expect([...repo.rows.keys()]).toEqual(['p1']);
  });

  it('abandon raced (abandoned:false) → same no_op body and no audit', async () => {
    const repo = new FakePromotionRepository([makeItem('i1')]);
    repo.abandonOpenSession = async () => ({ abandoned: false, discarded: 0 });
    const { services, abandonAudits } = makeClosedServices({ repo });

    const res = await postPromote(createApp(services), CLOSED_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'no_op', discarded: 0 });
    expect(abandonAudits).toHaveLength(0);
  });

  it('push-style ref refs/heads/<source_branch> (headRef null) is accepted', async () => {
    const { services } = makeClosedServices({
      principal: { ref: `refs/heads/${FEATURE}`, headRef: null },
    });

    const res = await postPromote(createApp(services), CLOSED_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'abandoned', discarded: 3 });
  });

  it('passes devRef refs/heads/<source_branch> to the verifier (closed_unmerged only)', async () => {
    const { services, verifyOpts } = makeClosedServices();

    await postPromote(createApp(services), CLOSED_BODY);

    expect(verifyOpts).toEqual([{ devRef: `refs/heads/${FEATURE}` }]);
  });

  // --- Denials: opaque 500, nothing abandoned, nothing audited ---

  const denyingPromoteAuthorizer: Authorizer = {
    ...makeStubAuthServices().authorizer,
    authorizePromote: async () => {
      throw new AppError(ErrorCode.PERMISSION_DENIED);
    },
  };

  const denials: Array<[string, ClosedSetup, Record<string, unknown>]> = [
    [
      'missing pr_number',
      {},
      { repo: OWNER_REPO, source_branch: FEATURE, event: 'closed_unmerged' },
    ],
    ['with merge_sha', {}, { ...CLOSED_BODY, merge_sha: 'abc123' }],
    ['unknown event value', {}, { ...CLOSED_BODY, event: 'reopened' }],
    [
      'refs/pull/7/merge with head_ref different from source_branch',
      { principal: { headRef: 'feature/other' } },
      CLOSED_BODY,
    ],
    ['refs/pull/7/merge with head_ref absent', { principal: { headRef: null } }, CLOSED_BODY],
    ['refs/pull/8/merge for pr_number 7', { principal: { ref: 'refs/pull/8/merge' } }, CLOSED_BODY],
    [
      'refs/heads/<other branch>',
      { principal: { ref: 'refs/heads/feature/other', headRef: null } },
      CLOSED_BODY,
    ],
    [
      'source_branch = default branch (main)',
      { principal: { ref: 'refs/heads/main', headRef: null } },
      { ...CLOSED_BODY, source_branch: 'main' },
    ],
    [
      'source_branch = default branch via PR ref (head_ref main)',
      { principal: { headRef: 'main' } },
      { ...CLOSED_BODY, source_branch: 'main' },
    ],
    [
      'body.repo differs from principal.repository',
      { principal: { repository: 'other-org/other-repo' } },
      CLOSED_BODY,
    ],
    ['unknown repo', { seedRepo: false }, CLOSED_BODY],
    [
      'no active machine credential (authorizePromote denies)',
      { authorizer: denyingPromoteAuthorizer },
      CLOSED_BODY,
    ],
  ];

  it.each(denials)('%s → opaque 500, nothing discarded', async (_name, setup, body) => {
    const { services, repo, abandonAudits } = makeClosedServices(setup);

    const res = await postPromote(createApp(services), body);

    expect(res.status).toBe(500);
    expect(res.body).toEqual(OPAQUE_ERROR_BODY);
    expect(repo.abandonCalls).toHaveLength(0);
    expect(repo.rows.size).toBe(3);
    expect(abandonAudits).toHaveLength(0);
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('feature');
    expect(serialised).not.toContain(PROJECT_ID);
  });
});

describe('POST /promote — merged path with event discriminator', () => {
  it("explicit event 'merged' on the default branch → unchanged outcome", async () => {
    const app = createApp(makeHappyServices());

    const res = await postPromote(app, { ...VALID_BODY, event: 'merged' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(HAPPY_OUTCOME);
  });

  it('merged event passes no devRef to the verifier', async () => {
    const verifyOpts: Array<OidcVerifyOptions | undefined> = [];
    const services = makeHappyServices();
    services.oidcVerifier = {
      verify: async (_authorization, opts) => {
        verifyOpts.push(opts);
        return {
          repository: OWNER_REPO,
          ref: 'refs/heads/main',
          headRef: null,
          eventName: 'push',
          jobWorkflowRef: `${OWNER_REPO}/.github/workflows/promote.yml@refs/heads/main`,
        };
      },
    };

    await postPromote(createApp(services), {
      repo: OWNER_REPO,
      source_branch: FEATURE,
      pr_number: PR,
    });

    expect(verifyOpts).toEqual([undefined]);
  });
});

// ---------------------------------------------------------------------------
// HU-04.1 — merged PR promotes its feature branch
// ---------------------------------------------------------------------------

describe('POST /promote — feature-branch promotion bound to the merged PR', () => {
  type PromoteMeta = Parameters<PromoteServiceLike['promote']>[1];

  function makeFeatureServices(
    ref = 'refs/heads/main',
    headRef: string | null = null,
    extra: Partial<PromotePrincipal> = {},
  ) {
    const promoteCalls: Array<{ sessionId: string; meta: PromoteMeta }> = [];
    const tenants: TenantContext[] = [];
    const services = makeStubAuthServices({
      oidcVerifier: makeOidcVerifier(OWNER_REPO, ref, headRef, extra),
      authRepository: new InMemoryAuthRepository([
        { remoteUrl: REMOTE_URL, repoId: REPO_ID, projectId: PROJECT_ID, defaultBranch: 'main' },
      ]),
      promotionRepository: {
        ...makePromotionRepo(SESSION_ID),
        findOpenSessionId: async (tenant: TenantContext) => {
          tenants.push(tenant);
          return SESSION_ID;
        },
      },
      promoteService: {
        promote: async (sessionId, meta) => {
          promoteCalls.push({ sessionId, meta });
          return HAPPY_OUTCOME;
        },
      },
    });
    return { services, promoteCalls, tenants };
  }

  it('default-branch token + feature source + pr_number → promotes the feature session with origin branch/PR', async () => {
    const { services, promoteCalls, tenants } = makeFeatureServices();

    const res = await postPromote(createApp(services), {
      repo: OWNER_REPO,
      source_branch: FEATURE,
      pr_number: PR,
      merge_sha: 'abc123',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(HAPPY_OUTCOME);
    const featureTenant = { projectId: PROJECT_ID, repoId: REPO_ID, branch: FEATURE };
    expect(tenants).toEqual([featureTenant]);
    expect(promoteCalls).toHaveLength(1);
    expect(promoteCalls[0].sessionId).toBe(SESSION_ID);
    expect(promoteCalls[0].meta.tenant).toEqual(featureTenant);
    expect(promoteCalls[0].meta.originBranch).toBe(FEATURE);
    expect(promoteCalls[0].meta.originPr).toBe(PR);
    expect(promoteCalls[0].meta.mergeSha).toBe('abc123');
  });

  it('default branch with pr_number → promotes the default session, origin PR recorded', async () => {
    const { services, promoteCalls } = makeFeatureServices();

    const res = await postPromote(createApp(services), { ...VALID_BODY, pr_number: PR });

    expect(res.status).toBe(200);
    expect(promoteCalls[0].meta.tenant.branch).toBe('main');
    expect(promoteCalls[0].meta.originBranch).toBe('main');
    expect(promoteCalls[0].meta.originPr).toBe(PR);
  });

  it('default branch without pr_number → promotes the default session, origin PR null', async () => {
    const { services, promoteCalls } = makeFeatureServices();

    const res = await postPromote(createApp(services), VALID_BODY);

    expect(res.status).toBe(200);
    expect(promoteCalls[0].meta.originBranch).toBe('main');
    expect(promoteCalls[0].meta.originPr).toBeNull();
  });

  it('feature source without pr_number → denied, nothing promoted', async () => {
    const { services, promoteCalls } = makeFeatureServices();

    const res = await postPromote(createApp(services), {
      repo: OWNER_REPO,
      source_branch: FEATURE,
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual(OPAQUE_ERROR_BODY);
    expect(promoteCalls).toHaveLength(0);
  });

  const nonDefaultTokens: Array<[string, string, string | null]> = [
    ['feature-branch token', `refs/heads/${FEATURE}`, null],
    ['PR merge-ref token', `refs/pull/${PR}/merge`, FEATURE],
  ];
  const sources: Array<[string, Record<string, unknown>]> = [
    ['feature source + pr_number', { repo: OWNER_REPO, source_branch: FEATURE, pr_number: PR }],
    ['default source', { repo: OWNER_REPO, source_branch: 'main' }],
    ['default source + pr_number', { repo: OWNER_REPO, source_branch: 'main', pr_number: PR }],
  ];
  const matrix = nonDefaultTokens.flatMap(([tName, ref, headRef]) =>
    sources.map(([sName, body]) => [`${tName}, ${sName}`, ref, headRef, body] as const),
  );

  it.each(matrix)('%s → denied, nothing promoted', async (_name, ref, headRef, body) => {
    const { services, promoteCalls } = makeFeatureServices(ref, headRef);

    const res = await postPromote(createApp(services), { ...body });

    expect(res.status).toBe(500);
    expect(res.body).toEqual(OPAQUE_ERROR_BODY);
    expect(promoteCalls).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain('feature');
  });

  // Verify M1: a default-branch ref is not enough — the token must come from the
  // push run of promote.yml on the default branch.
  const WF = `${OWNER_REPO}/.github/workflows`;
  const otherWorkflowTokens: Array<[string, Partial<PromotePrincipal>]> = [
    ['event pull_request_target', { eventName: 'pull_request_target' }],
    ['event workflow_dispatch', { eventName: 'workflow_dispatch' }],
    ['event schedule', { eventName: 'schedule' }],
    ['event_name absent', { eventName: null }],
    ['other workflow file', { jobWorkflowRef: `${WF}/other.yml@refs/heads/main` }],
    ['promote.yml on another ref', { jobWorkflowRef: `${WF}/promote.yml@refs/heads/${FEATURE}` }],
    [
      'promote.yml from another repository',
      { jobWorkflowRef: 'evil/fork/.github/workflows/promote.yml@refs/heads/main' },
    ],
    ['job_workflow_ref absent', { jobWorkflowRef: null }],
  ];
  const workflowMatrix = otherWorkflowTokens.flatMap(([tName, extra]) =>
    sources.map(([sName, body]) => [`${tName}, ${sName}`, extra, body] as const),
  );

  it.each(workflowMatrix)(
    'default-branch token, %s → denied, nothing promoted',
    async (_name, extra, body) => {
      const { services, promoteCalls } = makeFeatureServices('refs/heads/main', null, extra);

      const res = await postPromote(createApp(services), { ...body });

      expect(res.status).toBe(500);
      expect(res.body).toEqual(OPAQUE_ERROR_BODY);
      expect(promoteCalls).toHaveLength(0);
    },
  );
});

describe('POST /promote — DevOidcAuthenticator (devRef)', () => {
  const DEV_REPO = 'crombie-llc/gmemo-demo';

  function makeDevServices() {
    const repo = new FakePromotionRepository([makeItem('i1'), makeItem('i2')]);
    const services = makeStubAuthServices({
      oidcVerifier: new DevOidcAuthenticator(),
      authRepository: new InMemoryAuthRepository([
        {
          remoteUrl: `https://github.com/${DEV_REPO}.git`,
          repoId: REPO_ID,
          projectId: PROJECT_ID,
          defaultBranch: 'main',
        },
      ]),
      promotionRepository: repo,
      promoteService: makeScriptedPromoteService(HAPPY_OUTCOME),
    });
    return { services, repo };
  }

  it('closed_unmerged on feature/x works with the dev ref refs/heads/feature/x', async () => {
    const { services } = makeDevServices();

    const res = await postPromote(createApp(services), {
      repo: DEV_REPO,
      source_branch: FEATURE,
      pr_number: PR,
      event: 'closed_unmerged',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'abandoned', discarded: 2 });
  });

  it('merged on feature/x without pr_number is denied', async () => {
    const { services } = makeDevServices();

    const res = await postPromote(createApp(services), { repo: DEV_REPO, source_branch: FEATURE });

    expect(res.status).toBe(500);
    expect(res.body).toEqual(OPAQUE_ERROR_BODY);
  });

  it('merged on feature/x with pr_number → promoted (stub ref is the default branch)', async () => {
    const { services } = makeDevServices();

    const res = await postPromote(createApp(services), {
      repo: DEV_REPO,
      source_branch: FEATURE,
      pr_number: PR,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(HAPPY_OUTCOME);
  });

  it('merged on main → promote outcome as before', async () => {
    const { services } = makeDevServices();

    const res = await postPromote(createApp(services), { repo: DEV_REPO, source_branch: 'main' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(HAPPY_OUTCOME);
  });
});
