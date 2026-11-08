/**
 * Test helpers for the auth/RBAC path.
 *
 * Provides:
 *  - InMemoryAuthRepository  — seedable, deterministic fake of AuthRepository;
 *    captures all access_log inserts so tests can assert on them without a DB.
 *  - makeStubAuthServices()  — builds a minimal AppServices bag with always-succeed
 *    stubs, suitable for wiring createApp() / createMcpServer() in unrelated tests
 *    (e.g. health, registration) that do not exercise the auth or data chains.
 *
 * Promotion-pipeline additions (T007/T008/T009/T010):
 *  - InMemoryAuthRepository gains findRepoByGithubSlug + findActiveMachineCredential.
 *  - Stub Authorizer gains authorizePromote.
 *  - Stub AuditLogger gains recordPromote.
 *  - makeStubAuthServices() return type is widened to full AppServices including
 *    authRepository, promotionRepository, judge, oidcVerifier, promoteService.
 *
 * Web API (C2) additions:
 *  - FakeUser gains email/displayName; InMemoryAuthRepository gains
 *    findEnabledUserByEmail (case-insensitive) + listProjectsForUser (non-archived).
 *  - Stub Authorizer gains authorizeUser + authorizeProjectAdmin.
 *  - Stub AuditLogger gains recordApi + recordAbandon.
 *  - makeStubAuthServices(): reviewService stub (empty queue, everything
 *    not_found), headRef on the stub OIDC principal, and the three review/abandon
 *    methods on the stub promotion repository.
 */

import type {
  AuthRepository,
  RepoResolution,
  AppUser,
  AccessLogEntry,
} from '../../src/db/authRepository.js';
import type {
  AppServices,
  Authenticator,
  TenantResolver,
  Authorizer,
  AuditLogger,
  Principal,
  TenantContext,
  ActorIdentity,
  AdminActor,
  AuthenticatedUser,
  ProjectContext,
  ApiAction,
  ApiAuditDetail,
  JobAuditInput,
  ProjectMember,
  RequestContext,
  TenantResolutionInput,
  ToolName,
} from '../../src/mcp/context.js';
import type { Notifier } from '../../src/notify/notifier.js';
import type { Embedder } from '../../src/embedder/embedder.js';
import type { MemoryRepository } from '../../src/db/memoryRepository.js';
import type { StagingRepository } from '../../src/db/stagingRepository.js';
import type {
  PromotionRepository,
  PromotionItemRow,
  ApplyContext,
  ApplyResult,
  PersistedDecision,
  QuarantineInput,
  SanitizeFlags,
  ReviewApproveInput,
  ReviewRejectInput,
} from '../../src/db/promotionRepository.js';
import type { ReviewServiceLike } from '../../src/http/api/types.js';
import type { QuarantineServiceLike } from '../../src/quarantine/quarantineService.js';
import type { LifecycleServiceLike } from '../../src/lifecycle/types.js';
import type { DirectMemoryServiceLike } from '../../src/memory/types.js';
import type { Judge, JudgeItem } from '../../src/judge/judge.js';
import type { OidcVerifier, PromotePrincipal } from '../../src/auth/oidcAuthenticator.js';
import { PromoteService } from '../../src/promote/promoteService.js';
import { InMemoryMemoryRepository } from '../memory/fakes.js';

// ---------------------------------------------------------------------------
// Seed data shapes
// ---------------------------------------------------------------------------

/** Seed record for a repo row (maps to the `repo` table). */
export interface FakeRepo {
  remoteUrl: string;
  repoId: string;
  projectId: string;
  defaultBranch: string;
}

/**
 * Seed record for an app_user row.
 * `disabled: true` simulates `disabled_at IS NOT NULL` — the user is excluded
 * from findEnabledUserBySubject results, same as a non-existent user.
 */
export interface FakeUser {
  subject: string;
  userId: string;
  globalRole: string | null;
  /** Defaults to `<subject>@test.local`. */
  email?: string;
  displayName?: string | null;
  disabled?: boolean;
}

/** Seed record for a project row (used by listProjectsForUser). */
export interface FakeProject {
  projectId: string;
  slug: string;
  name: string;
  /** Simulates `archived_at IS NOT NULL` — excluded from listProjectsForUser. */
  archived?: boolean;
}

/** Seed record for a project_membership row. */
export interface FakeMembership {
  projectId: string;
  userId: string;
  role: string;
}

/** Seed record for a machine_credential row (active = not revoked, not expired). */
export interface FakeMachineCredential {
  projectId: string;
  principalName: string;
  role: string;
  /** When false, findActiveMachineCredential returns null (simulates revoked/expired). */
  active: boolean;
}

// ---------------------------------------------------------------------------
// InMemoryAuthRepository
// ---------------------------------------------------------------------------

/** Allowed roles for findActiveMachineCredential (mirrors the SQL IN clause). */
const ALLOWED_MACHINE_ROLES = new Set(['service_agent', 'contributor', 'project_admin']);

/**
 * In-memory implementation of AuthRepository used in unit tests.
 *
 * Seed arrays are provided at construction time and held in lookup maps for
 * O(1) access. All writes (insertAccessLog) are appended to
 * `this.accessLogEntries` so tests can inspect them with
 * `expect(repo.accessLogEntries).toHaveLength(...)`.
 */
export class InMemoryAuthRepository implements AuthRepository {
  /** All access_log entries inserted via insertAccessLog, in insertion order. */
  public readonly accessLogEntries: AccessLogEntry[] = [];

  private readonly repoByRemoteUrl = new Map<string, RepoResolution>();
  private readonly userBySubject = new Map<
    string,
    AppUser & { subject: string; disabled: boolean }
  >();
  private readonly memberships: FakeMembership[];
  private readonly projectById = new Map<string, FakeProject>();
  /** Key: `${projectId}:${userId}` → role string. */
  private readonly membershipKey = new Map<string, string>();
  /** Key: `${projectId}:${principalName}` → FakeMachineCredential. */
  private readonly machineCredentialKey = new Map<string, FakeMachineCredential>();

  constructor(
    repos: FakeRepo[] = [],
    users: FakeUser[] = [],
    memberships: FakeMembership[] = [],
    machineCredentials: FakeMachineCredential[] = [],
    projects: FakeProject[] = [],
  ) {
    for (const r of repos) {
      this.repoByRemoteUrl.set(r.remoteUrl, {
        repoId: r.repoId,
        projectId: r.projectId,
        defaultBranch: r.defaultBranch,
      });
    }

    for (const u of users) {
      this.userBySubject.set(u.subject, {
        subject: u.subject,
        userId: u.userId,
        globalRole: u.globalRole,
        email: u.email ?? `${u.subject}@test.local`,
        displayName: u.displayName ?? null,
        disabled: u.disabled ?? false,
      });
    }

    this.memberships = [...memberships];
    for (const p of projects) {
      this.projectById.set(p.projectId, p);
    }

    for (const m of memberships) {
      this.membershipKey.set(`${m.projectId}:${m.userId}`, m.role);
    }

    for (const mc of machineCredentials) {
      this.machineCredentialKey.set(`${mc.projectId}:${mc.principalName}`, mc);
    }
  }

  async findRepoByRemoteUrl(remoteUrl: string): Promise<RepoResolution | null> {
    return this.repoByRemoteUrl.get(remoteUrl) ?? null;
  }

  /** Canonicalizes ownerRepo to `https://github.com/<ownerRepo>.git` and looks up. */
  async findRepoByGithubSlug(ownerRepo: string): Promise<RepoResolution | null> {
    const remoteUrl = `https://github.com/${ownerRepo}.git`;
    return this.findRepoByRemoteUrl(remoteUrl);
  }

  async findEnabledUserBySubject(subject: string): Promise<AppUser | null> {
    const user = this.userBySubject.get(subject);
    // Disabled users are treated identically to absent users (no enumeration).
    if (!user || user.disabled) return null;
    return {
      userId: user.userId,
      globalRole: user.globalRole,
      email: user.email,
      displayName: user.displayName,
    };
  }

  async findEnabledUserByEmail(
    email: string,
  ): Promise<{ userId: string; idpSubject: string } | null> {
    const wanted = email.toLowerCase();
    for (const user of this.userBySubject.values()) {
      if (!user.disabled && user.email.toLowerCase() === wanted) {
        return { userId: user.userId, idpSubject: user.subject };
      }
    }
    return null;
  }

  async listProjectsForUser(
    userId: string,
  ): Promise<Array<{ projectId: string; slug: string; name: string; role: string }>> {
    const result: Array<{ projectId: string; slug: string; name: string; role: string }> = [];
    for (const m of this.memberships) {
      const project = this.projectById.get(m.projectId);
      if (m.userId !== userId || !project || project.archived) continue;
      result.push({ projectId: project.projectId, slug: project.slug, name: project.name, role: m.role });
    }
    // Mirrors ORDER BY p.name, p.id.
    return result.sort(
      (a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId),
    );
  }

  async findMembershipRole(projectId: string, userId: string): Promise<string | null> {
    return this.membershipKey.get(`${projectId}:${userId}`) ?? null;
  }

  async isProjectActive(projectId: string): Promise<boolean> {
    const project = this.projectById.get(projectId);
    return project !== undefined && !project.archived;
  }

  async insertAccessLog(entry: AccessLogEntry): Promise<void> {
    this.accessLogEntries.push(entry);
  }

  async findActiveMachineCredential(
    projectId: string,
    principalName: string,
  ): Promise<{ role: string } | null> {
    const cred = this.machineCredentialKey.get(`${projectId}:${principalName}`);
    if (!cred || !cred.active) return null;
    if (!ALLOWED_MACHINE_ROLES.has(cred.role)) return null;
    return { role: cred.role };
  }
}

// ---------------------------------------------------------------------------
// Stub AuthServices factory
// ---------------------------------------------------------------------------

/**
 * Default stub principal returned by the stub authenticator.
 * Tests that need a specific principal can override `authenticator`.
 */
const STUB_PRINCIPAL: Principal = {
  subject: 'stub-sub',
  clientId: 'stub-client',
  scopes: ['read:memory'],
};

/** Default stub tenant returned by the stub tenant resolver. */
const STUB_TENANT: TenantContext = {
  projectId: 'stub-project',
  repoId: 'stub-repo',
  branch: 'main',
};

/** Default stub actor returned by the stub authorizer. */
const STUB_ACTOR: ActorIdentity = {
  actorId: 'stub-sub',
  userId: 'stub-user-id',
  roles: ['viewer'],
};

/** Default admin actor returned by the stub authorizeProjectAdmin. */
const STUB_ADMIN: AdminActor = {
  actorId: 'stub-sub',
  userId: 'stub-user-id',
  roles: ['project_admin'],
};

/** Default member returned by the stub authorizeProjectMember. */
const STUB_MEMBER: ProjectMember = {
  actorId: 'stub-sub',
  userId: 'stub-user-id',
  roles: ['project_admin'],
  projectRole: 'project_admin',
};

/** Default user returned by the stub authorizeUser. */
const STUB_USER: AuthenticatedUser = {
  actorId: 'stub-sub',
  userId: 'stub-user-id',
  email: 'stub@test.local',
  displayName: 'Stub User',
  globalRole: null,
};

/**
 * Builds a full AppServices bag with always-succeed stubs.
 *
 * Used in tests that exercise unrelated functionality (health endpoint,
 * MCP tool registration) and merely need createApp()/createMcpServer() to
 * compile and not crash — they never exercise the auth, data, or promotion chains.
 *
 * Partial overrides are accepted so individual tests can replace one seam
 * while keeping the rest as no-ops.
 */
export function makeStubAuthServices(overrides: Partial<AppServices> = {}): AppServices {
  const stubAuthenticator: Authenticator = {
    authenticate(_authorization: string | undefined): Promise<Principal> {
      return Promise.resolve(STUB_PRINCIPAL);
    },
  };

  const stubTenantResolver: TenantResolver = {
    resolve(_input: TenantResolutionInput): Promise<TenantContext> {
      return Promise.resolve(STUB_TENANT);
    },
  };

  const stubAuthorizer: Authorizer = {
    authorize(_principal: Principal, _tenant: TenantContext, _tool: ToolName): Promise<ActorIdentity> {
      return Promise.resolve(STUB_ACTOR);
    },
    authorizePromote(_principal: PromotePrincipal, _tenant: TenantContext): Promise<ActorIdentity> {
      return Promise.resolve(STUB_ACTOR);
    },
    authorizeUser(_principal: Principal): Promise<AuthenticatedUser> {
      return Promise.resolve(STUB_USER);
    },
    authorizeProjectAdmin(_principal: Principal, _projectId: string): Promise<AdminActor> {
      return Promise.resolve(STUB_ADMIN);
    },
    authorizeProjectMember(_principal: Principal, _projectId: string): Promise<ProjectMember> {
      return Promise.resolve(STUB_MEMBER);
    },
  };

  const stubAuditLogger: AuditLogger = {
    recordRead(_ctx: RequestContext, _tool: ToolName, _queryHash?: string): Promise<void> {
      return Promise.resolve();
    },
    recordWrite(
      _ctx: RequestContext,
      _params: {
        tool: 'remember' | 'discard_staged';
        sessionId?: string;
        itemId: string;
        contentHash?: string;
      },
    ): Promise<void> {
      return Promise.resolve();
    },
    recordPromote(
      _ctx: RequestContext,
      _p: {
        sessionId: string;
        applied: number;
        quarantined: number;
        uncertain: number;
        prNumber: number | null;
        mergeSha: string | null;
      },
    ): Promise<void> {
      return Promise.resolve();
    },
    recordApi(
      _actor: ActorIdentity,
      _project: ProjectContext | null,
      _action: ApiAction,
      _detail?: ApiAuditDetail,
    ): Promise<void> {
      return Promise.resolve();
    },
    recordAbandon(
      _ctx: RequestContext,
      _p: { sessionId: string; discarded: number; prNumber: number },
    ): Promise<void> {
      return Promise.resolve();
    },
    recordJob(_p: JobAuditInput): Promise<void> {
      return Promise.resolve();
    },
  };

  // Default: empty in-memory fake (no seed data).  Tests that need specific
  // memory data should build their own InMemoryMemoryRepository and pass it
  // directly to the handler under test, rather than going through this stub.
  const stubMemoryRepository: MemoryRepository = new InMemoryMemoryRepository();

  // Stub staging repository: all methods are no-ops / empty returns.
  // listStagingItems returns [] so recall's staged-mix produces no records
  // in tests that do not seed staging data (first-page empty staged = unchanged results).
  const stubStagingRepository: StagingRepository = {
    findOrCreateOpenSession: () => Promise.resolve(''),
    insertStagingItem: () =>
      Promise.resolve({ id: '', judgeState: 'pending' as const, deduped: false }),
    listStagingItems: () => Promise.resolve([]),
    discardStagingItem: () => Promise.resolve(false),
    createSingleItemSession: (i) => Promise.resolve({ sessionId: i.sessionId, itemId: '' }),
  };

  // Stub promotion repository: all methods return benign values.
  const stubPromotionRepository: PromotionRepository = {
    findOpenSessionId: (_tenant: TenantContext) => Promise.resolve(null),
    fetchPromotableItems: (_sessionId: string, _projectId: string) =>
      Promise.resolve([] as PromotionItemRow[]),
    findJudgeContext: (
      _projectId: string,
      _text: { title: string; summary: string },
      _excludeMemoryId: string | null,
    ) => Promise.resolve([]),
    persistMasked: (
      _itemId: string,
      _content: { title: string; summary: string; body: string; fields: Record<string, unknown> },
      _contentHash: string,
      _flags: SanitizeFlags,
    ) => Promise.resolve('ok' as const),
    recordDecision: (_itemId: string, _d: PersistedDecision, _flags: SanitizeFlags) =>
      Promise.resolve(),
    applyAccepted: (_item: PromotionItemRow, _ctx: ApplyContext, _embedding: number[] | null): Promise<ApplyResult> =>
      Promise.resolve({ status: 'applied' as const, memoryId: '', deduped: false }),
    quarantineItem: (_item: PromotionItemRow, _ctx: ApplyContext, _q: QuarantineInput) =>
      Promise.resolve(null),
    finalizeSession: (_sessionId: string, _status: 'promoted' | 'rejected' | 'partially_promoted') =>
      Promise.resolve(),
    approveReviewItem: (_i: ReviewApproveInput) => Promise.resolve({ status: 'not_found' as const }),
    rejectReviewItem: (_i: ReviewRejectInput) => Promise.resolve('not_found' as const),
    abandonOpenSession: (_sessionId: string, _projectId: string) =>
      Promise.resolve({ abandoned: false, discarded: 0 }),
  };

  // Stub judge: always returns an accepted JudgeResult.
  const stubJudge: Judge = {
    evaluate: (_item: JudgeItem) =>
      Promise.resolve({
        verdict: 'accepted' as const,
        criterion: 'confidence' as const,
        confidence: 0.9,
        reason: 'stub',
        relatedMemoryId: null,
      }),
  };

  // Stub notifier: no-op.
  const stubNotifier: Notifier = { notify: () => Promise.resolve() };

  // Stub OIDC verifier: returns a fixed promote principal.
  const stubOidcVerifier: OidcVerifier = {
    verify: (_authorization: string | undefined) =>
      Promise.resolve({ repository: 'stub-owner/stub-repo', ref: 'refs/heads/main', headRef: null }),
  };

  // Stub auth repository (no seed data — tests that need specific data build their own).
  const stubAuthRepository: AuthRepository = {
    findRepoByRemoteUrl: (_remoteUrl: string) => Promise.resolve(null),
    findRepoByGithubSlug: (_ownerRepo: string) => Promise.resolve(null),
    findEnabledUserBySubject: (_subject: string) => Promise.resolve(null),
    findEnabledUserByEmail: (_email: string) => Promise.resolve(null),
    listProjectsForUser: (_userId: string) => Promise.resolve([]),
    findMembershipRole: (_projectId: string, _userId: string) => Promise.resolve(null),
    isProjectActive: (_projectId: string) => Promise.resolve(false),
    insertAccessLog: (_entry: AccessLogEntry) => Promise.resolve(),
    findActiveMachineCredential: (_projectId: string, _principalName: string) =>
      Promise.resolve(null),
  };

  // Stub embedder: no-op that returns an empty vector.
  const stubEmbedder: Embedder = { embed: (_: string) => Promise.resolve([] as number[]) };

  // Stub PromoteService: instantiated with the stubs above so the private
  // `deps` field is satisfied without a cast.
  const stubPromoteService = new PromoteService({
    promotionRepository: stubPromotionRepository,
    judge: stubJudge,
    auditLogger: stubAuditLogger,
    embedder: stubEmbedder,
    notifier: stubNotifier,
    routing: { confidenceThreshold: 0.8, mandatoryReviewTypes: new Set() },
  });

  // Stub review service: empty queue; every item lookup/decision is not_found.
  const stubReviewService: ReviewServiceLike = {
    list: () =>
      Promise.resolve({
        items: [],
        counters: { pending: 0, uncertain: 0, mandatory: 0, resolvedLast7Days: 0 },
        truncated: false,
      }),
    get: () => Promise.resolve(null),
    approve: () => Promise.resolve({ kind: 'not_found' as const }),
    reject: () => Promise.resolve({ kind: 'not_found' as const }),
  };

  // Stub quarantine service: empty list; every lookup/restore is not_found.
  const stubQuarantineService: QuarantineServiceLike = {
    list: () => Promise.resolve({ items: [], truncated: false }),
    get: () => Promise.resolve(null),
    restore: () => Promise.resolve({ kind: 'not_found' as const }),
  };

  // Stub lifecycle service: every memory lookup is not_found; sweep is a no-op.
  const stubLifecycleService: LifecycleServiceLike = {
    confirm: () => Promise.resolve({ kind: 'not_found' as const }),
    retire: () => Promise.resolve({ kind: 'not_found' as const }),
    retireByPr: () => Promise.resolve({ kind: 'retired' as const, dto: { retired: 0 } }),
    sweep: () => Promise.resolve({ job: 'revalidation-sweep', count: 0, detail: {} }),
  };

  // Stub direct memory service (C5): empty list; every lookup/write is not_found.
  const stubDirectMemoryService: DirectMemoryServiceLike = {
    list: () => Promise.resolve({ items: [], nextCursor: null, truncated: false }),
    get: () => Promise.resolve(null),
    preview: () => Promise.resolve({ kind: 'not_found' as const }),
    create: () => Promise.resolve({ kind: 'not_found' as const }),
    amend: () => Promise.resolve({ kind: 'not_found' as const }),
  };

  return {
    authenticator: stubAuthenticator,
    tenantResolver: stubTenantResolver,
    authorizer: stubAuthorizer,
    auditLogger: stubAuditLogger,
    memoryRepository: stubMemoryRepository,
    stagingRepository: stubStagingRepository,
    authRepository: stubAuthRepository,
    promotionRepository: stubPromotionRepository,
    judge: stubJudge,
    oidcVerifier: stubOidcVerifier,
    promoteService: stubPromoteService,
    embedder: stubEmbedder,
    notifier: stubNotifier,
    reviewService: stubReviewService,
    quarantineService: stubQuarantineService,
    lifecycleService: stubLifecycleService,
    directMemoryService: stubDirectMemoryService,
    ...overrides,
  };
}
