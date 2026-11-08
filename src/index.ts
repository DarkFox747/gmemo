/**
 * Service entrypoint — single composition root.
 *
 * Boot sequence:
 *  1. Load + validate config from environment (fail-fast on invalid values).
 *  2. Apply LOG_LEVEL so every subsequent log respects the configured level.
 *  3. Create the pg Pool singleton (one pool for the process lifetime).
 *  4. Gate-1 authenticator: if AUTH_DEV_BYPASS && NODE_ENV!=='production', use
 *     DevAuthenticator (loud WARN banner); else build CognitoJwtVerifier with
 *     best-effort hydrate() — boot does NOT hard-depend on Cognito reachability.
 *  5. Construct PgAuthRepository and the four auth seam singletons.
 *  6. Assemble AppServices and hand it to createApp.
 *  7. Listen on the configured HOST:PORT.
 *  8. Register SIGTERM/SIGINT handlers for graceful shutdown.
 *
 * Nothing is constructed per-request in this file; the singletons built here
 * are injected through createApp(services) → makeMcpPostHandler(services).
 */

import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { JwtRsaVerifier } from 'aws-jwt-verify/jwt-rsa';
import { loadConfig } from './config/index.js';
import { logger, setLogLevel } from './observability/logger.js';
import { createApp } from './http/app.js';
import { createPool, closePool } from './db/pool.js';
import { PgAuthRepository } from './db/authRepository.js';
import { PgMemoryRepository } from './db/memoryRepository.js';
import { PgStagingRepository } from './db/stagingRepository.js';
import { PgPromotionRepository } from './db/promotionRepository.js';
import { PgReviewQueueRepository } from './db/reviewQueueRepository.js';
import { PgQuarantineRepository } from './db/quarantineRepository.js';
import { PgLifecycleRepository } from './db/lifecycleRepository.js';
import { PgMemoryAdminRepository } from './db/memoryAdminRepository.js';
import { CognitoAuthenticator } from './auth/authenticator.js';
import { DevAuthenticator } from './auth/devAuthenticator.js';
import { DevOidcAuthenticator } from './auth/devOidcAuthenticator.js';
import {
  GithubOidcAuthenticator,
  GITHUB_OIDC_ISSUER,
  GITHUB_OIDC_JWKS_URI,
} from './auth/oidcAuthenticator.js';
import { RdsTenantResolver } from './auth/tenantResolver.js';
import { RdsAuthorizer } from './auth/authorizer.js';
import { RdsAuditLogger } from './auth/auditLogger.js';
import { DeterministicJudge } from './judge/deterministicJudge.js';
import { BedrockJudge } from './judge/bedrockJudge.js';
import { StubEmbedder } from './embedder/stubEmbedder.js';
import { BedrockEmbedder } from './embedder/bedrockEmbedder.js';
import { logNotifier } from './notify/notifier.js';
import { PromoteService } from './promote/promoteService.js';
import { ReviewService } from './review/reviewService.js';
import { QuarantineService } from './quarantine/quarantineService.js';
import { purgeExpiredQuarantine, QUARANTINE_PURGE_JOB } from './quarantine/purge.js';
import { LifecycleService } from './lifecycle/lifecycleService.js';
import { REVALIDATION_SWEEP_JOB } from './lifecycle/types.js';
import { DirectMemoryService } from './memory/directMemoryService.js';
import { reapStaleWebSessions, WEB_SESSION_REAPER_JOB } from './memory/webSessionReaper.js';
import type { JobsRouterDeps } from './jobs/jobsRouter.js';
import { isJobsEnabled } from './jobs/jobsRouter.js';
import type { AppServices, Authenticator } from './mcp/context.js';
import type { Judge } from './judge/judge.js';
import type { OidcVerifier } from './auth/oidcAuthenticator.js';
import type { Embedder } from './embedder/embedder.js';
import type { MemoryType } from './contracts/memory.js';
import type { RoutingConfig } from './promote/routing.js';

// --- 1. Config (fail-fast; exits on invalid env) ---
const config = loadConfig();

// --- 2. Logging level ---
setLogLevel(config.LOG_LEVEL);

// --- 3. Database pool (process-level singleton) ---
const pool = createPool(config.DATABASE_URL, config.NODE_ENV === 'production');

// --- 4. Gate-1 authenticator: dev stub vs real Cognito (composition root) ---
// The auth repository is built first: DevAuthenticator resolves X-Dev-User through it.
const authRepository = new PgAuthRepository(pool);
let authenticator: Authenticator;
// X-Dev-User is forwarded on /api only on the dev-bypass branch below (D1 layer 1);
// apiAuth and DevAuthenticator re-check NODE_ENV independently.
let devUserHeader = false;

if (config.AUTH_DEV_BYPASS && config.NODE_ENV !== 'production') {
  // Defense in depth: loadConfig() already fails fast on the prod pairing;
  // this second check keeps the stub structurally unreachable in production.
  logger.warn('════════════════════════════════════════════════════════════');
  logger.warn('[boot] AUTH_DEV_BYPASS ACTIVE — Gate 1 (Cognito) is STUBBED.');
  logger.warn('[boot] DevAuthenticator returns a FIXED principal. DEV ONLY.');
  logger.warn('[boot] Gate 2 (RDS user+membership), RBAC and audit remain REAL.');
  logger.warn('════════════════════════════════════════════════════════════');
  logger.warn('[boot] /api honours X-Dev-User (<email of a seeded, enabled user>). DEV ONLY.');
  authenticator = new DevAuthenticator(authRepository);
  devUserHeader = true;
} else {
  // Real path. superRefine guarantees these are present here; the explicit
  // guard satisfies the type-checker (COGNITO_* are optional in Config).
  if (
    !config.COGNITO_USER_POOL_ID ||
    !config.COGNITO_CLIENT_ID_ALLOWLIST ||
    !config.COGNITO_REQUIRED_SCOPE
  ) {
    throw new Error('[boot] Cognito configuration missing on the real auth path');
  }
  // CognitoJwtVerifier derives the issuer URL and JWKS endpoint from userPoolId,
  // validates token_use='access', client_id allowlist, and required scope.
  // Region is derived from the pool ID by aws-jwt-verify — no COGNITO_REGION needed.
  // aud is intentionally NOT validated — Cognito access tokens use client_id.
  const cognitoVerifier = CognitoJwtVerifier.create({
    userPoolId: config.COGNITO_USER_POOL_ID,
    tokenUse: 'access',
    clientId: config.COGNITO_CLIENT_ID_ALLOWLIST,
    scope: config.COGNITO_REQUIRED_SCOPE,
  });
  // Best-effort JWKS pre-fetch: warms the in-process key cache before traffic
  // arrives. Non-fatal — the verifier lazy-fetches on the first verify() call
  // when this fails, so boot must not hard-depend on Cognito reachability.
  cognitoVerifier.hydrate().catch((err: unknown) => {
    logger.warn('[boot] Cognito JWKS pre-fetch failed (non-fatal; retries on first verify)', err);
  });
  authenticator = new CognitoAuthenticator(cognitoVerifier);
}

// --- 5. Auth seam implementations (authRepository is built in step 4) ---

// --- 5b. Memory repository (change B: data-model) ---
const memoryRepository = new PgMemoryRepository(pool);

// --- 5c. Staging repository (change D: staging write path) ---
const stagingRepository = new PgStagingRepository(pool);

// --- 5d. Promotion repository (promotion-pipeline) ---
const promotionRepository = new PgPromotionRepository(pool, {
  quarantineRetentionDays: config.QUARANTINE_RETENTION_DAYS,
  revalidationDays: config.REVALIDATION_DAYS,
});

// --- 5e. Judge: dev stub vs Bedrock skeleton (composition root) ---
let judge: Judge;

if (config.JUDGE_STUB && config.NODE_ENV !== 'production') {
  // Defense in depth: loadConfig() already fails fast on the prod pairing;
  // this second check keeps the stub structurally unreachable in production.
  logger.warn('════════════════════════════════════════════════════════════');
  logger.warn(
    `[boot] JUDGE_STUB ACTIVE — heuristic DeterministicJudge (accepted confidence ${config.JUDGE_STUB_CONFIDENCE}). DEV/TEST ONLY.`,
  );
  logger.warn('[boot] Set JUDGE_STUB=false (and provide BEDROCK_MODEL_ID) for production.');
  logger.warn('════════════════════════════════════════════════════════════');
  judge = new DeterministicJudge({ acceptedConfidence: config.JUDGE_STUB_CONFIDENCE });
} else {
  // superRefine guarantees BEDROCK_MODEL_ID and AWS_REGION are present on this path.
  judge = new BedrockJudge({
    modelId: config.BEDROCK_MODEL_ID!,
    region: config.AWS_REGION!,
    maxAttempts: config.BEDROCK_MAX_ATTEMPTS,
    timeoutMs: config.BEDROCK_TIMEOUT_MS,
  });
}

// --- 5f. OIDC verifier: dev bypass vs GithubOidcAuthenticator (composition root) ---
let oidcVerifier: OidcVerifier;

if (config.PROMOTE_OIDC_DEV_BYPASS && config.NODE_ENV !== 'production') {
  // Defense in depth: loadConfig() already fails fast on the prod pairing;
  // this second check keeps the bypass structurally unreachable in production.
  logger.warn('════════════════════════════════════════════════════════════');
  logger.warn('[boot] PROMOTE_OIDC_DEV_BYPASS ACTIVE — GitHub OIDC verification is STUBBED.');
  logger.warn('[boot] DevOidcAuthenticator returns a fixed principal. DEV ONLY.');
  logger.warn('[boot] Set PROMOTE_OIDC_DEV_BYPASS=false (+ GITHUB_OIDC_AUDIENCE) for production.');
  logger.warn('════════════════════════════════════════════════════════════');
  oidcVerifier = new DevOidcAuthenticator();
} else {
  // superRefine guarantees GITHUB_OIDC_AUDIENCE is present on this path.
  // Build the real JWKS verifier once at boot; the in-process cache handles
  // key rotation transparently across requests.
  const githubOidcVerifier = JwtRsaVerifier.create({
    issuer: GITHUB_OIDC_ISSUER,
    audience: config.GITHUB_OIDC_AUDIENCE!,
    jwksUri: GITHUB_OIDC_JWKS_URI,
  });
  oidcVerifier = new GithubOidcAuthenticator(githubOidcVerifier);
}

// --- 5g. AuditLogger singleton (reused by promoteService below) ---
const auditLogger = new RdsAuditLogger(authRepository);

// --- 5h. Embedder: dev stub vs Bedrock skeleton (composition root) ---
let embedder: Embedder;

if (config.EMBEDDER_STUB && config.NODE_ENV !== 'production') {
  // Defense in depth: loadConfig() already fails fast on the prod pairing;
  // this second check keeps the stub structurally unreachable in production.
  logger.warn('════════════════════════════════════════════════════════════');
  logger.warn('[boot] EMBEDDER_STUB ACTIVE — StubEmbedder (deterministic, non-semantic).');
  logger.warn('[boot] Embeddings are pseudo-random. DEV/TEST ONLY.');
  logger.warn('[boot] Set EMBEDDER_STUB=false (and provide BEDROCK_EMBEDDING_MODEL_ID) for production.');
  logger.warn('════════════════════════════════════════════════════════════');
  embedder = new StubEmbedder();
} else {
  // superRefine guarantees BEDROCK_EMBEDDING_MODEL_ID and AWS_REGION are present on this path.
  embedder = new BedrockEmbedder({
    modelId: config.BEDROCK_EMBEDDING_MODEL_ID!,
    region: config.AWS_REGION!,
    maxAttempts: config.BEDROCK_MAX_ATTEMPTS,
    timeoutMs: config.BEDROCK_TIMEOUT_MS,
  });
}

// --- 5i. Routing config (judge threshold + mandatory review types) ---
// loadConfig() already rejected unknown types, so the cast is safe.
const routing: RoutingConfig = {
  confidenceThreshold: config.JUDGE_CONFIDENCE_THRESHOLD,
  mandatoryReviewTypes: new Set(config.MANDATORY_REVIEW_TYPES as MemoryType[]),
};
if (routing.mandatoryReviewTypes.size === 0) {
  logger.warn(
    '[boot] MANDATORY_REVIEW_TYPES is empty — only supersede/deprecate require human review.',
  );
}

// --- 5j. PromoteService ---
const promoteService = new PromoteService({
  promotionRepository,
  judge,
  auditLogger,
  embedder,
  notifier: logNotifier,
  routing,
});

// --- 5k. Human review queue (HU-07): reads via the queue repository, writes via promotion ---
const reviewQueueRepository = new PgReviewQueueRepository(pool);
const reviewService = new ReviewService({
  reviewQueueRepository,
  promotionRepository,
  embedder,
  confidenceThreshold: config.JUDGE_CONFIDENCE_THRESHOLD,
});

// --- 5l. Quarantine (C3, HU-10): list/detail/restore through the same pipeline ---
const quarantineRepository = new PgQuarantineRepository(pool);
const quarantineService = new QuarantineService({ quarantineRepository, promoteService });

// --- 5l'. Memory lifecycle (C4, HU-12, HU-11.4): confirm/retire + revalidation sweep ---
const lifecycleService = new LifecycleService({
  lifecycleRepository: new PgLifecycleRepository(pool, {
    revalidationDays: config.REVALIDATION_DAYS,
  }),
});

// --- 5l''. Direct memory management (C5, HU-13): browse, preview, confirm add/amend.
// Same judge, routing object and PromoteService as promotion (human-approved mode). ---
const directMemoryService = new DirectMemoryService({
  memoryAdminRepository: new PgMemoryAdminRepository(pool),
  stagingRepository,
  promotionRepository,
  promoteService,
  reviewQueueRepository,
  quarantineRepository,
  judge,
  routing,
});

const services: AppServices = {
  authenticator, // ← selected above: DevAuthenticator or CognitoAuthenticator
  tenantResolver: new RdsTenantResolver(authRepository),
  authorizer: new RdsAuthorizer(authRepository),
  auditLogger,   // ← same singleton used by promoteService
  memoryRepository,
  stagingRepository,
  authRepository,
  promotionRepository,
  judge,
  oidcVerifier,
  promoteService,
  embedder,                                                  // ← shared by PromoteService + recall handler
  notifier: logNotifier,
  reviewService,
  quarantineService,
  lifecycleService,
  directMemoryService,
};

// --- 5m. Internal jobs (/internal/jobs): enabled anywhere a JOBS_TOKEN is
// configured, or without one only under an EXPLICIT NODE_ENV=development (the raw
// env, not config's 'development' default: unset NODE_ENV never opens it). The
// router re-checks open mode itself (third layer). ---
const jobsEnabled = isJobsEnabled(process.env.NODE_ENV, config.JOBS_TOKEN);
const jobs: JobsRouterDeps = {
  jobs: {
    [QUARANTINE_PURGE_JOB]: () => purgeExpiredQuarantine(quarantineRepository),
    [REVALIDATION_SWEEP_JOB]: () => lifecycleService.sweep(),
    [WEB_SESSION_REAPER_JOB]: () => reapStaleWebSessions(stagingRepository),
  },
  token: config.JOBS_TOKEN,
  enabled: jobsEnabled,
  audit: auditLogger,
};
if (jobsEnabled && config.JOBS_TOKEN === undefined) {
  logger.warn('[boot] /internal/jobs enabled WITHOUT a token (development only).');
}

// --- 5n. DEV ONLY static web: loadConfig() already rejects WEB_STATIC_DIR in
// production; this second check keeps it structurally unreachable there. ---
const webStaticDir =
  config.WEB_STATIC_DIR && config.NODE_ENV !== 'production' ? config.WEB_STATIC_DIR : undefined;
if (webStaticDir) {
  logger.warn('[boot] WEB_STATIC_DIR set — serving the web build from Express. DEV ONLY.');
}

// --- 6 + 7. Build app and listen ---
// Pass the rate-limit window/max values from config; enabled is ON in
// production (superRefine already rejected RATE_LIMIT_ENABLED=false there).
const app = createApp(services, {
  rateLimit: {
    enabled: config.RATE_LIMIT_ENABLED,
    mcpWindowMs: config.RATE_LIMIT_MCP_WINDOW_MS,
    mcpMax: config.RATE_LIMIT_MCP_MAX,
    promoteWindowMs: config.RATE_LIMIT_PROMOTE_WINDOW_MS,
    promoteMax: config.RATE_LIMIT_PROMOTE_MAX,
    apiWindowMs: config.RATE_LIMIT_API_WINDOW_MS,
    apiMax: config.RATE_LIMIT_API_MAX,
  },
  devUserHeader,
  webStaticDir,
  jobs,
});

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info(`gmemo listening on http://${config.HOST}:${config.PORT}`);
  logger.info(`NODE_ENV=${config.NODE_ENV} LOG_LEVEL=${config.LOG_LEVEL}`);
});

// --- 8. Graceful shutdown ---
// Close the HTTP server (stop accepting new connections) then drain the DB pool.
const shutdown = (signal: string): void => {
  logger.info(`[shutdown] ${signal} received — shutting down gracefully`);
  server.close(() => {
    closePool(pool)
      .then(() => {
        logger.info('[shutdown] Shutdown complete');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error('[shutdown] Error during pool close', err);
        process.exit(1);
      });
  });
};

process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
