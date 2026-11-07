// Secret-scanning module — pure, no runtime dependencies, no node:crypto usage.
// Detects common high-signal credential patterns across free-text content.
//
// Design: Decision 2 (write-path design.md).
// Contract: scanForSecrets() returns CATEGORY NAMES only — never matched text.
//           assertNoSecrets() is fail-closed: any internal error is treated as a
//           positive finding so unscanned content is never persisted.

import { AppError, ErrorCode } from '../errors/appError.js';
import { logger } from '../observability/logger.js';

interface SecretPattern {
  readonly category: string;
  readonly pattern: RegExp;
}

/**
 * Broad but simple regex patterns covering the most common credential forms.
 * Each pattern is stateless (no `g` flag) so `.test()` is safe to call on
 * repeated invocations without resetting `lastIndex`.
 */
const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  // AWS access-key IDs: AKIA or ASIA prefix + exactly 16 uppercase A-Z0-9 chars
  {
    category: 'aws_access_key_id',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  // PEM private-key header blocks (RSA, EC, PKCS8, etc.)
  {
    category: 'pem_private_key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  // JWTs: header.payload.signature — header and payload both start with eyJ
  {
    category: 'jwt',
    pattern: /eyJ[A-Za-z0-9_-]{2,}\.eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]+/,
  },
  // GitHub tokens: gh followed by one scope char (p=PAT, o=OAuth, u=user, s=server, r=refresh)
  {
    category: 'github_token',
    pattern: /gh[pousr]_[A-Za-z0-9]{20,}/,
  },
  // Slack tokens: xox followed by one type char (b=bot, a=app, p=legacy, r=rtm, s=service)
  {
    category: 'slack_token',
    pattern: /xox[baprs]-/,
  },
  // Google API keys: AIza prefix + 35 URL-safe base64 chars
  {
    category: 'google_api_key',
    pattern: /AIza[0-9A-Za-z_-]{35}/,
  },
  // Stripe secret keys (sk_live_) and restricted keys (rk_live_)
  {
    category: 'stripe_secret_key',
    pattern: /(?:sk|rk)_live_/,
  },
  // OpenAI API keys: sk- prefix + 20+ alphanumeric chars
  {
    category: 'openai_api_key',
    pattern: /sk-[A-Za-z0-9]{20,}/,
  },
  // Generic secret-assignment heuristic: keyword followed by = or : then a long value.
  // Case-insensitive to catch PASSWORD=, Secret:, TOKEN =, api_key: etc.
  {
    category: 'secret_assignment',
    pattern: /(?:password|secret|token|api[_-]?key)\s*[=:]\s*\S{12,}/i,
  },
];

/**
 * Scans `text` for credential patterns and returns the matched category names.
 * Never returns or logs the matched text itself.
 *
 * @returns Array of category name strings for each pattern that matched.
 *          Empty array means no findings.
 */
export function scanForSecrets(text: string): string[] {
  const found: string[] = [];
  for (const { category, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      found.push(category);
    }
  }
  return found;
}

/**
 * Asserts that none of the provided string parts contain recognisable secrets.
 *
 * Joins all `parts` with a newline, then runs `scanForSecrets`. On ANY finding,
 * or if the scanner itself throws (fail-closed), logs ONLY category names via
 * the repo logger and throws `AppError(PERMISSION_DENIED)`.
 *
 * The matched text is never logged or surfaced — this function is the enforcement
 * boundary that guarantees secret material cannot leak into the audit trail.
 *
 * @throws {AppError} with code `PERMISSION_DENIED` if any pattern matches or
 *                    if the scanner encounters an unexpected error.
 */
export function assertNoSecrets(...parts: string[]): void {
  try {
    const text = parts.join('\n');
    const categories = scanForSecrets(text);
    if (categories.length > 0) {
      logger.warn('Content rejected by secret scan', { categories });
      throw new AppError(ErrorCode.PERMISSION_DENIED);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Internal scanner error — treat as a positive to prevent unscanned content
    // from being persisted (fail-closed contract).
    logger.warn('Secret scan internal error; rejecting content as precaution', {
      categories: [],
    });
    throw new AppError(ErrorCode.PERMISSION_DENIED, err);
  }
}
