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
import { DirectMemoryService } from '../../../src/memory/directMemoryService.js';
import {
  DIRECT_ROUTING,
  FakeMemoryAdminRepository,
  RecordingPromotionRepository,
  RecordingStagingRepository,
  ScriptedDirectPromote,
} from '../../memory/directFakes.js';
import { FakeJudge } from '../../promote/fakes.js';
import type { AdminSummaryRepository } from '../../../src/db/adminSummaryRepository.js';
import type {
  ActivityListDto,
  AdminSummaryDto,
  DashboardDto,
  StagingOverviewDto,
} from '../../../src/http/api/types.js';
import type {
  ActivityQuery,
  InsightsRepository,
  StagingQuery,
} from '../../../src/db/insightsRepository.js';

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

/** Admin summary fake (C7): one summary per project id; records every lookup. */
export class FakeAdminSummaryRepository implements AdminSummaryRepository {
  summaries = new Map<string, AdminSummaryDto>();
  calls: string[] = [];

  async getAdminSummary(projectId: string): Promise<AdminSummaryDto | null> {
    this.calls.push(projectId);
    return this.summaries.get(projectId) ?? null;
  }
}

/** Empty dashboard (no data, no labels). */
export function emptyDashboard(): DashboardDto {
  return {
    generatedAt: '2026-11-08T10:00:00.000Z',
    windowDays: 30,
    memories: {
      total: 0,
      byStatus: { active: 0, pending_revalidation: 0, superseded: 0, deprecated: 0 },
      activeByType: {
        decision: 0,
        constraint: 0,
        gotcha: 0,
        pattern: 0,
        integration_note: 0,
        domain_rule: 0,
        outcome: 0,
      },
    },
    queue: { pending: 0, uncertain: 0, mandatory: 0 },
    quarantine: { active: 0, byCriterion: { pipeline: 0, judge: 0, human_review: 0 } },
    judge: {
      outcomes: { accepted: 0, uncertain: 0, rejected: 0, pipelineBlocked: 0, notEvaluated: 0 },
      labels: {
        uncertainApproved: 0,
        uncertainRejected: 0,
        acceptedApproved: 0,
        acceptedRejected: 0,
        restoredFromJudge: 0,
      },
      restoredOther: { pipeline: 0, humanReview: 0 },
      unlabeled: { autoApplied: 0, judgeRejectedNotRestored: 0 },
      falsePositive: { count: 0, of: 0, rate: null },
      falseNegative: { count: 0, of: 0, rate: null },
    },
  };
}

/** Insights fake (C12): scripted DTOs; records every call with its query. */
export class FakeInsightsRepository implements InsightsRepository {
  dashboard: DashboardDto = emptyDashboard();
  activity: ActivityListDto = { items: [], nextCursor: null };
  staging: StagingOverviewDto = { sessions: [], truncated: false };
  calls: Array<{ method: string; projectId: string; q?: ActivityQuery | StagingQuery }> = [];

  async getDashboard(projectId: string): Promise<DashboardDto> {
    this.calls.push({ method: 'getDashboard', projectId });
    return this.dashboard;
  }

  async listActivity(projectId: string, q: ActivityQuery): Promise<ActivityListDto> {
    this.calls.push({ method: 'listActivity', projectId, q });
    return this.activity;
  }

  async listStaging(projectId: string, q: StagingQuery): Promise<StagingOverviewDto> {
    this.calls.push({ method: 'listStaging', projectId, q });
    return this.staging;
  }
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
  /** Backing fakes of the default (real) DirectMemoryService (C5). */
  direct: {
    adminRepo: FakeMemoryAdminRepository;
    staging: RecordingStagingRepository;
    promotion: RecordingPromotionRepository;
    promote: ScriptedDirectPromote;
    quarantine: FakeQuarantineRepository;
    judge: FakeJudge;
  };
  /** Backing fake of the admin summary route (C7). */
  adminSummaryRepo: FakeAdminSummaryRepository;
  /** Backing fake of the insights routes (C12). */
  insightsRepo: FakeInsightsRepository;
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
  const direct = {
    adminRepo: new FakeMemoryAdminRepository(),
    staging: new RecordingStagingRepository(),
    promotion: new RecordingPromotionRepository(),
    promote: new ScriptedDirectPromote(),
    quarantine: new FakeQuarantineRepository(),
    judge: new FakeJudge(),
  };

  const adminSummaryRepo = new FakeAdminSummaryRepository();
  const insightsRepo = new FakeInsightsRepository();

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
    directMemoryService: new DirectMemoryService({
      memoryAdminRepository: direct.adminRepo,
      stagingRepository: direct.staging,
      promotionRepository: direct.promotion,
      promoteService: direct.promote,
      reviewQueueRepository: direct.adminRepo,
      quarantineRepository: direct.quarantine,
      judge: direct.judge,
      routing: DIRECT_ROUTING,
    }),
    adminSummaryRepository: adminSummaryRepo,
    insightsRepository: insightsRepo,
    ...overrides,
  };

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', makeApiRouter(deps, options));
  app.use('/api', apiErrorHandler);
  return {
    app, authRepo, authenticator, queueRepo, promotionRepo, embedder, quarantineRepo, quarantinePromote,
    lifecycleRepo, direct, adminSummaryRepo, insightsRepo,
  };
}
