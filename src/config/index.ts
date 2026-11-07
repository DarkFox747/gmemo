import { z } from 'zod';
import { MEMORY_TYPES } from '../mcp/tools/schemas.js';

/**
 * Strict 0..1 decimal from an env string. A regex (not z.coerce.number) so that
 * an empty string never silently becomes 0. Surrounding whitespace is trimmed first.
 */
const unitInterval = (def: string) =>
  z
    .string()
    .trim()
    .regex(/^(0(\.\d+)?|1(\.0+)?)$/, 'must be a decimal between 0 and 1')
    .default(def)
    .transform(Number);

const envSchema = z
  .object({
    // Server
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    // Database
    DATABASE_URL: z.string().min(1),

    // Dev harness — Gate-1 bypass flag. Safe boolean (NOT z.coerce.boolean,
    // which treats "false" as true). Guarded in superRefine below.
    AUTH_DEV_BYPASS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    // Cognito — Gate 1. OPTIONAL at the field level; REQUIRED by superRefine
    // only on the real path (AUTH_DEV_BYPASS !== true).
    // Note: COGNITO_REGION is intentionally absent — aws-jwt-verify derives the
    // region from the user pool ID and does not require it as a separate variable.
    COGNITO_USER_POOL_ID: z.string().min(1).optional(),
    /** Comma-separated list of allowed Cognito client IDs (at least one required). */
    COGNITO_CLIENT_ID_ALLOWLIST: z
      .string()
      .min(1)
      .transform((s) => s.split(',').map((id) => id.trim()).filter(Boolean))
      .refine((arr) => arr.length > 0, {
        message: 'COGNITO_CLIENT_ID_ALLOWLIST must contain at least one client ID',
      })
      .optional(),
    COGNITO_REQUIRED_SCOPE: z.string().min(1).optional(),

    // Judge seam — deterministic stub for dev/test; guarded in superRefine below.
    // Safe boolean via z.enum (NOT z.coerce.boolean, which treats "false" as true).
    JUDGE_STUB: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Confidence an accepted DeterministicJudge verdict reports (dev/test only).
    JUDGE_STUB_CONFIDENCE: unitInterval('0.9'),
    // Accepted verdicts below this confidence are routed to the human review queue.
    JUDGE_CONFIDENCE_THRESHOLD: unitInterval('0.8'),
    // CSV of memory types that always require human review. An empty list is
    // allowed outside production (the composition root warns at boot) and
    // forbidden in production (superRefine below).
    MANDATORY_REVIEW_TYPES: z
      .string()
      .default('decision,constraint,domain_rule')
      .transform((s) => s.split(',').map((t) => t.trim()).filter(Boolean))
      .refine((arr) => arr.every((t) => (MEMORY_TYPES as readonly string[]).includes(t)), {
        message: `MANDATORY_REVIEW_TYPES must only contain: ${MEMORY_TYPES.join(', ')}`,
      }),
    // Real Bedrock judge requires a model ID; OPTIONAL at field level; REQUIRED by
    // superRefine on the real path (JUDGE_STUB !== true).
    BEDROCK_MODEL_ID: z.string().min(1).optional(),

    // OIDC verifier seam — dev bypass for /promote; guarded in superRefine below.
    PROMOTE_OIDC_DEV_BYPASS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Real GitHub OIDC verifier requires an audience; OPTIONAL at field level;
    // REQUIRED by superRefine on the real path (PROMOTE_OIDC_DEV_BYPASS !== true).
    GITHUB_OIDC_AUDIENCE: z.string().min(1).optional(),

    // Embedder seam — deterministic stub for dev/test; guarded in superRefine below.
    // Safe boolean via z.enum (NOT z.coerce.boolean, which treats "false" as true).
    EMBEDDER_STUB: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Real Bedrock embedder requires a model ID; OPTIONAL at field level; REQUIRED by
    // superRefine on the real path (EMBEDDER_STUB !== true).
    BEDROCK_EMBEDDING_MODEL_ID: z.string().min(1).optional(),

    // Bedrock client tuning — shared across both the embedder and judge real paths.
    // AWS_REGION is OPTIONAL at field level; REQUIRED by superRefine when either
    // real Bedrock client is active (EMBEDDER_STUB=false OR JUDGE_STUB=false).
    // Credentials come from the default AWS provider chain — never in config.
    AWS_REGION: z.string().min(1).optional(),
    // Retry policy: one try + (maxAttempts-1) retries via SDK standard retry mode.
    // Parsed like SEMANTIC_FALLBACK_*: coerce string env var to integer, enforce ≥ 1.
    BEDROCK_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
    // Per-request timeout in milliseconds, enforced by AbortController.
    BEDROCK_TIMEOUT_MS: z.coerce.number().int().min(1).default(15000),

    // Semantic fallback thresholds — two-phase recall (lexical-first, semantic fallback).
    // Parsed like PORT: coerce string env var to integer, enforce ≥ 1.
    SEMANTIC_FALLBACK_MIN_RESULTS: z.coerce.number().int().min(1).default(5),
    SEMANTIC_FALLBACK_K: z.coerce.number().int().min(1).default(8),

    // Rate limiting — express-rate-limit in-process limiter (no Redis/WAF).
    // Safe boolean via z.enum (NOT z.coerce.boolean, which treats "false" as true).
    // Guarded in superRefine below: disabled=false is FORBIDDEN in production.
    RATE_LIMIT_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    // Per-route window + max — coerced from string env vars, must be integers ≥ 1.
    RATE_LIMIT_MCP_WINDOW_MS: z.coerce.number().int().min(1).default(60000),
    RATE_LIMIT_MCP_MAX: z.coerce.number().int().min(1).default(120),
    RATE_LIMIT_PROMOTE_WINDOW_MS: z.coerce.number().int().min(1).default(60000),
    RATE_LIMIT_PROMOTE_MAX: z.coerce.number().int().min(1).default(10),
  })
  .superRefine((cfg, ctx) => {
    // ── LOAD-BEARING PROD GUARD ───────────────────────────────────────────────
    // The dev auth bypass MUST be impossible in production. Fail to load.
    if (cfg.AUTH_DEV_BYPASS && cfg.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_DEV_BYPASS'],
        message:
          'AUTH_DEV_BYPASS=true is forbidden when NODE_ENV=production — ' +
          'the dev auth bypass cannot run in production.',
      });
    }

    // ── Real Cognito path requires its vars ───────────────────────────────────
    if (!cfg.AUTH_DEV_BYPASS) {
      if (!cfg.COGNITO_USER_POOL_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['COGNITO_USER_POOL_ID'],
          message: 'COGNITO_USER_POOL_ID is required when AUTH_DEV_BYPASS is not true.',
        });
      }
      if (!cfg.COGNITO_CLIENT_ID_ALLOWLIST) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['COGNITO_CLIENT_ID_ALLOWLIST'],
          message: 'COGNITO_CLIENT_ID_ALLOWLIST is required when AUTH_DEV_BYPASS is not true.',
        });
      }
      if (!cfg.COGNITO_REQUIRED_SCOPE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['COGNITO_REQUIRED_SCOPE'],
          message: 'COGNITO_REQUIRED_SCOPE is required when AUTH_DEV_BYPASS is not true.',
        });
      }
    }

    // ── LOAD-BEARING PROD GUARD — judge stub ──────────────────────────────────
    // The deterministic judge stub MUST be impossible in production. Fail to load.
    if (cfg.JUDGE_STUB && cfg.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JUDGE_STUB'],
        message: 'JUDGE_STUB=true is forbidden when NODE_ENV=production.',
      });
    }

    // ── LOAD-BEARING PROD GUARD — review routing floor ───────────────────────
    // In production a near-zero threshold or an empty mandatory list would let
    // the judge auto-apply governed memory types without a human. Fail to load.
    if (cfg.NODE_ENV === 'production') {
      if (cfg.JUDGE_CONFIDENCE_THRESHOLD < 0.5) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JUDGE_CONFIDENCE_THRESHOLD'],
          message: 'JUDGE_CONFIDENCE_THRESHOLD must be >= 0.5 when NODE_ENV=production.',
        });
      }
      if (cfg.MANDATORY_REVIEW_TYPES.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MANDATORY_REVIEW_TYPES'],
          message: 'MANDATORY_REVIEW_TYPES must not be empty when NODE_ENV=production.',
        });
      }
    }

    // ── Real Bedrock judge path requires a model ID ───────────────────────────
    if (!cfg.JUDGE_STUB && !cfg.BEDROCK_MODEL_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BEDROCK_MODEL_ID'],
        message: 'BEDROCK_MODEL_ID is required when JUDGE_STUB is not true.',
      });
    }

    // ── LOAD-BEARING PROD GUARD — OIDC dev bypass ────────────────────────────
    // The OIDC dev bypass MUST be impossible in production. Fail to load.
    if (cfg.PROMOTE_OIDC_DEV_BYPASS && cfg.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PROMOTE_OIDC_DEV_BYPASS'],
        message: 'PROMOTE_OIDC_DEV_BYPASS=true is forbidden when NODE_ENV=production.',
      });
    }

    // ── Real GitHub OIDC verifier path requires an audience ──────────────────
    if (!cfg.PROMOTE_OIDC_DEV_BYPASS && !cfg.GITHUB_OIDC_AUDIENCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GITHUB_OIDC_AUDIENCE'],
        message: 'GITHUB_OIDC_AUDIENCE is required when PROMOTE_OIDC_DEV_BYPASS is not true.',
      });
    }

    // ── LOAD-BEARING PROD GUARD — embedder stub ───────────────────────────────
    // The deterministic embedder stub MUST be impossible in production. Fail to load.
    if (cfg.EMBEDDER_STUB && cfg.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMBEDDER_STUB'],
        message: 'EMBEDDER_STUB=true is forbidden when NODE_ENV=production.',
      });
    }

    // ── Real Bedrock embedder path requires a model ID ────────────────────────
    if (!cfg.EMBEDDER_STUB && !cfg.BEDROCK_EMBEDDING_MODEL_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BEDROCK_EMBEDDING_MODEL_ID'],
        message: 'BEDROCK_EMBEDDING_MODEL_ID is required when EMBEDDER_STUB is not true.',
      });
    }

    // ── LOAD-BEARING PROD GUARD — rate-limiting disabled ─────────────────────
    // Rate limiting MUST be enabled in production. Fail to load when disabled.
    if (!cfg.RATE_LIMIT_ENABLED && cfg.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RATE_LIMIT_ENABLED'],
        message:
          'RATE_LIMIT_ENABLED=false is forbidden when NODE_ENV=production — ' +
          'rate limiting must be active in production.',
      });
    }

    // ── AWS_REGION required when any real Bedrock client is active ────────────
    // anyRealBedrock is true when EITHER the embedder OR the judge uses real
    // Bedrock (i.e., at least one stub is off). In that case, an explicit region
    // must be provided — credentials come from the default provider chain, but
    // region is never auto-detected to keep boot fail-fast and observable.
    const anyRealBedrock = !cfg.EMBEDDER_STUB || !cfg.JUDGE_STUB;
    if (anyRealBedrock && !cfg.AWS_REGION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AWS_REGION'],
        message:
          'AWS_REGION is required when a real Bedrock client is active (EMBEDDER_STUB=false or JUDGE_STUB=false).',
      });
    }
  });

export type Config = z.infer<typeof envSchema>;

/**
 * Validates and returns the application configuration from environment variables.
 * Calls process.exit(1) immediately if any required variable is invalid — fail-fast
 * so misconfigured deploys never serve traffic with unknown env state.
 */
export function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    // Log structured error details then exit before the server opens a socket.
    // Never expose raw process.env values; only report field-level messages.
    const formatted = result.error.format();
    console.error('[config] Invalid environment variables:', JSON.stringify(formatted, null, 2));
    process.exit(1);
  }
  return result.data;
}
