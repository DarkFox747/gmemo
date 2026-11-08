/**
 * Test helpers for the REST layer (/api).
 *
 * makeApiTestApp() builds a bare express() app with JSON parsing, the API
 * router and the /api error mapper — the same mounting order as createApp —
 * wired to REAL RdsAuthorizer + RdsAuditLogger over an InMemoryAuthRepository,
 * so permission and audit assertions exercise the production RBAC code.
 *
 * Gate 1 is a fake: `Authorization: Bearer <subject>` → Principal{subject};
 * a missing/other header throws PERMISSION_DENIED (like the real verifier).
 */

import express from 'express';
import { AppError, ErrorCode } from '../../../src/errors/appError.js';
import { makeApiRouter } from '../../../src/http/api/router.js';
import { apiErrorHandler } from '../../../src/http/api/errorHandler.js';
import { RdsAuthorizer } from '../../../src/auth/authorizer.js';
import { RdsAuditLogger } from '../../../src/auth/auditLogger.js';
import { ReviewService } from '../../../src/review/reviewService.js';
import type { AuthenticateOptions, Authenticator, Principal } from '../../../src/mcp/context.js';
import type { ApiRouterDeps, ApiRouterOptions } from '../../../src/http/api/types.js';
import { InMemoryAuthRepository } from '../../auth/fakes.js';
import { FakeEmbedder, FakePromotionRepo, FakeQueueRepo } from '../../review/fakes.js';
import { QuarantineService } from '../../../src/quarantine/quarantineService.js';
import { FakeQuarantineRepository, ScriptedPromoteService } from '../../quarantine/fakes.js';
import { LifecycleService } from '../../../src/lifecycle/lifecycleService.js';
import { FakeLifecycleRepository } from '../../lifecycle/fakes.js';

// ---------------------------------------------------------------------------
// Seed: two projects, one admin each, plus every non-admin shape.
// ---------------------------------------------------------------------------

export const PROJECT_A = '00000000-0000-0000-0000-0000000000a1';
export const PROJECT_B = '00000000-0000-0000-0000-0000000000b1';
export const ARCHIVED_PROJECT = '00000000-0000-0000-0000-0000000000c1';
export const RANDOM_PROJECT = '6f1c0d52-1a5e-4a8e-9a3b-6a2f3f0e9c11';
export const ITEM_ID = '11111111-2222-4333-8444-555555555555';

export const USERS = {
  adminA: {
    subject: 'sub-admin-a',
    userId: 'u-admin-a',
    email: 'tl@demo.local',
    displayName: 'TL A',
  },
  adminB: {
    subject: 'sub-admin-b',
    userId: 'u-admin-b',
    email: 'tl-b@demo.local',
    displayName: null,
  },
  contributorA: {
    subject: 'sub-contrib-a',
    userId: 'u-contrib-a',
    email: 'dev@demo.local',
    displayName: 'Dev',
  },
  viewerA: {
    subject: 'sub-viewer-a',
    userId: 'u-viewer-a',
    email: 'viewer@demo.local',
    displayName: 'Viewer',
  },
  serviceA: {
    subject: 'sub-service-a',
    userId: 'u-service-a',
    email: 'svc@demo.local',
    displayName: null,
  },
  platformAdmin: {
    subject: 'sub-platform',
    userId: 'u-platform',
    email: 'pa@demo.local',
    displayName: null,
  },
  disabledAdminA: {
    subject: 'sub-disabled',
    userId: 'u-disabled',
    email: 'gone@demo.local',
    displayName: null,
  },
} as const;

export function makeAuthRepo(): InMemoryAuthRepository {
  return new InMemoryAuthRepository(
    [],
    [
      { ...USERS.adminA, globalRole: null },
      { ...USERS.adminB, globalRole: null },
      { ...USERS.contributorA, globalRole: null },
      { ...USERS.viewerA, globalRole: null },
      { ...USERS.serviceA, globalRole: null },
      { ...USERS.platformAdmin, globalRole: 'platform_admin' },
      { ...USERS.disabledAdminA, globalRole: null, disabled: true },
    ],
    [
      { projectId: PROJECT_A, userId: USERS.adminA.userId, role: 'project_admin' },
      { projectId: ARCHIVED_PROJECT, userId: USERS.adminA.userId, role: 'project_admin' },
      { projectId: PROJECT_B, userId: USERS.adminB.userId, role: 'project_admin' },
      { projectId: PROJECT_A, userId: USERS.contributorA.userId, role: 'contributor' },
      { projectId: PROJECT_A, userId: USERS.viewerA.userId, role: 'viewer' },
      { projectId: PROJECT_A, userId: USERS.serviceA.userId, role: 'service_agent' },
      { projectId: PROJECT_A, userId: USERS.disabledAdminA.userId, role: 'project_admin' },
    ],
    [],
    [
      { projectId: PROJECT_A, slug: 'alpha', name: 'Alpha' },
      { projectId: PROJECT_B, slug: 'beta', name: 'Beta' },
      { projectId: ARCHIVED_PROJECT, slug: 'old', name: 'Old', archived: true },
    ],
  );
}

/** Fake Gate 1: `Bearer <subject>` → principal. Records every call for assertions. */
export class FakeBearerAuthenticator implements Authenticator {
  calls: Array<{ authorization: string | undefined; opts: AuthenticateOptions | undefined }> = [];

  async authenticate(
    authorization: string | undefined,
    opts?: AuthenticateOptions,
  ): Promise<Principal> {
    this.calls.push({ authorization, opts });
    const m = /^Bearer (\S+)$/.exec(authorization ?? '');
    if (!m) throw new AppError(ErrorCode.PERMISSION_DENIED);
    return { subject: m[1], clientId: 'test-client', scopes: [] };
  }
}

export function bearer(user: { subject: string }): string {
  return `Bearer ${user.subject}`;
}

export interface ApiTestKit {
  app: express.Express;
  authRepo: InMemoryAuthRepository;
  authenticator: FakeBearerAuthenticator;
  queueRepo: FakeQueueRepo;
  promotionRepo: FakePromotionRepo;
  embedder: FakeEmbedder;
  /** Backing fakes of the default (real) QuarantineService. */
  quarantineRepo: FakeQuarantineRepository;
  quarantinePromote: ScriptedPromoteService;
  /** Backing fake of the default (real) LifecycleService (C4). */
  lifecycleRepo: FakeLifecycleRepository;
}

export function makeApiTestApp(
  overrides: Partial<ApiRouterDeps> = {},
  options: ApiRouterOptions = { devUserHeader: false },
): ApiTestKit {
  const authRepo = makeAuthRepo();
  const authenticator = new FakeBearerAuthenticator();
  const queueRepo = new FakeQueueRepo();
  const promotionRepo = new FakePromotionRepo();
  const embedder = new FakeEmbedder();
  const quarantineRepo = new FakeQuarantineRepository();
  const quarantinePromote = new ScriptedPromoteService();
  const lifecycleRepo = new FakeLifecycleRepository();

  const deps: ApiRouterDeps = {
    authenticator,
    authorizer: new RdsAuthorizer(authRepo),
    auditLogger: new RdsAuditLogger(authRepo),
    authRepository: authRepo,
    reviewService: new ReviewService({
      reviewQueueRepository: queueRepo,
      promotionRepository: promotionRepo,
      embedder,
      confidenceThreshold: 0.8,
    }),
    quarantineService: new QuarantineService({
      quarantineRepository: quarantineRepo,
      promoteService: quarantinePromote,
    }),
    lifecycleService: new LifecycleService({ lifecycleRepository: lifecycleRepo }),
    ...overrides,
  };

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', makeApiRouter(deps, options));
  app.use('/api', apiErrorHandler);
  return {
    app, authRepo, authenticator, queueRepo, promotionRepo, embedder, quarantineRepo, quarantinePromote,
    lifecycleRepo,
  };
}
