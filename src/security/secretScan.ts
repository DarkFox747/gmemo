// Secret-scanning module — pure, no runtime dependencies, no node:crypto usage.
// Detects common high-signal credential patterns across free-text content.
//
// Design: Decision 2 (write-path design.md).
// Contract: scanForSecrets() returns CATEGORY NAMES only — never matched text.
//           assertNoSecrets() is fail-closed: any internal error is treated as a
//           positive finding so unscanned content is never persisted.

import { AppError, ErrorCode } from '../errors/appError.js';
import { logger } from '../observability/logger.js';
import { normalizeForScan } from './normalizeForScan.js';

interface SecretPattern {
  readonly category: string;
  readonly pattern: RegExp;
  /**
   * Global regex used ONLY to locate spans for redaction (C3). It differs from
   * the detector where the detector is prefix-only (slack, stripe) or stops
   * before the token end (openai: `_`/`-` tail), matches a
   * header only (PEM, extended to the END line in code) or would also cover the
   * keyword (assignment, AWS secret: value only). When the range has a capture
   * group, the span is that group (it ends the match, so no lookbehind is needed).
   */
  readonly range: RegExp;
}

/** AWS secret key name + separator + exactly 40 base64 chars (group 1 = value). */
const AWS_SECRET_ASSIGNMENT =
  /(?:aws[_\- ]?secret(?:(?:[_\- ]?access)?[_\- ]?key)?|secretAccessKey)["']?(?:\s*[=:]\s*|\s+)["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/i;

/**
 * A bare 40-char base64 token (exactly 40: no base64 char on either side). On its
 * own it is indistinguishable from a hash; next to an AWS access key id in the
 * same text it is treated as that key's secret.
 */
const AWS_BARE_SECRET = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/;
const AWS_BARE_SECRET_RANGE = new RegExp(AWS_BARE_SECRET.source, 'g');

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
    range: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  // PEM private-key header blocks (RSA, EC, PKCS8, etc.)
  {
    category: 'pem_private_key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    range: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  // JWTs: header.payload.signature — header and payload both start with eyJ
  {
    category: 'jwt',
    pattern: /eyJ[A-Za-z0-9_-]{2,}\.eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]+/,
    range: /eyJ[A-Za-z0-9_-]{2,}\.eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]+/g,
  },
  // GitHub tokens: gh followed by one scope char (p=PAT, o=OAuth, u=user, s=server, r=refresh)
  {
    category: 'github_token',
    pattern: /gh[pousr]_[A-Za-z0-9]{20,}/,
    range: /gh[pousr]_[A-Za-z0-9]{20,}/g,
  },
  // Slack tokens: xox followed by one type char (b=bot, a=app, p=legacy, r=rtm, s=service)
  {
    category: 'slack_token',
    pattern: /xox[baprs]-/,
    range: /xox[baprs]-[A-Za-z0-9-]*/g,
  },
  // Google API keys: AIza prefix + 35 URL-safe base64 chars
  {
    category: 'google_api_key',
    pattern: /AIza[0-9A-Za-z_-]{35}/,
    range: /AIza[0-9A-Za-z_-]{35}/g,
  },
  // Stripe secret keys (sk_live_) and restricted keys (rk_live_)
  {
    category: 'stripe_secret_key',
    pattern: /(?:sk|rk)_live_/,
    range: /(?:sk|rk)_live_[A-Za-z0-9]*/g,
  },
  // OpenAI API keys: sk- prefix + 20+ alphanumeric chars. The range runs to the
  // end of the token (`_`/`-` included, SEC-L1); the lookahead keeps it on the
  // detector's own hits so words like "task-list" are never redacted.
  {
    category: 'openai_api_key',
    pattern: /sk-[A-Za-z0-9]{20,}/,
    range: /sk-(?=[A-Za-z0-9]{20})[A-Za-z0-9_-]*/g,
  },
  // Kind-prefixed `sk-` keys: sk-<2..10 letters>-<token>. Covers OpenAI project /
  // service-account / admin keys (sk-proj-, sk-svcacct-, sk-admin-, sk-None-) and
  // other vendors' families (Anthropic sk-ant-, OpenRouter sk-or-). The inner `-`
  // keeps openai_api_key from matching; `\b` keeps words like "risk-adjusted-…"
  // out. The token body allows `_`/`-`, so the range runs to the end of the key.
  {
    category: 'openai_project_key',
    pattern: /\bsk-[A-Za-z]{2,10}-[A-Za-z0-9_-]{20,}/,
    range: /\bsk-[A-Za-z]{2,10}-[A-Za-z0-9_-]{20,}/g,
  },
  // GitHub fine-grained PATs: github_pat_ + 22 alnum + `_` + 59 alnum.
  {
    category: 'github_fine_grained_pat',
    pattern: /github_pat_[A-Za-z0-9_]{20,}/,
    range: /github_pat_[A-Za-z0-9_]{20,}/g,
  },
  // AWS secret access keys: a bare 40-char base64 run is indistinguishable from a
  // hash, so the detector is anchored to an AWS secret key name (aws_secret,
  // aws_secret_key, AWS secret access key, SDK camelCase, a JSON key) followed by
  // `=`/`:` or whitespace (optional quotes) and requires exactly 40 characters.
  // Detector and range share the separators; the range span is the value group.
  // The AKIA/ASIA pairing (a bare 40-char token next to an access key id) is
  // handled in scanForSecrets / scanForSecretsWithRanges.
  {
    category: 'aws_secret_access_key',
    pattern: AWS_SECRET_ASSIGNMENT,
    range: new RegExp(AWS_SECRET_ASSIGNMENT.source, 'gi'),
  },
  // Generic secret-assignment heuristic: keyword followed by = or : then a long value.
  // Case-insensitive to catch PASSWORD=, Secret:, TOKEN =, api_key: etc. The range
  // span is the value group, never across a newline.
  {
    category: 'secret_assignment',
    pattern: /(?:password|secret|token|api[_-]?key)\s*[=:]\s*\S{12,}/i,
    range: /(?:password|secret|token|api[_-]?key)[ \t]*[=:][ \t]*(\S{12,})/gi,
  },
];

/** An AWS access key id plus a bare 40-char token in the same text: a key pair. */
function hasAwsKeyPair(text: string, categories: readonly string[]): boolean {
  return categories.includes('aws_access_key_id') && AWS_BARE_SECRET.test(text);
}

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
  if (hasAwsKeyPair(text, found) && !found.includes('aws_secret_access_key')) {
    found.push('aws_secret_access_key');
  }
  return found;
}

/** Half-open span [start, end) of a located secret. */
export interface SecretRange {
  start: number;
  end: number;
}

/** Same bound as maskPii: callers cap content far below it; oversize fails closed. */
const MAX_RANGE_INPUT_LENGTH = 10_000;

/**
 * End of a PEM block that starts at `from`: just past the matching END line, or
 * the end of the text when the block is unterminated (redact to the end). A
 * local regex + exec from `from` keeps the search linear (no lazy-regex ReDoS).
 */
function findPemEnd(text: string, from: number): number {
  const endRe = /-----END [A-Z ]*PRIVATE KEY-----/g;
  endRe.lastIndex = from;
  const e = endRe.exec(text);
  return e ? e.index + e[0].length : text.length;
}

/**
 * Detects secrets (same categories as scanForSecrets) and locates their spans,
 * merged (overlapping or adjacent spans fold) and sorted. Never logs.
 * Callers must verify the redacted result: a detection without a span (e.g. an
 * assignment split across a newline) is possible and must fail closed.
 *
 * @throws {RangeError} when text.length > 10_000 (callers fail closed).
 */
export function scanForSecretsWithRanges(text: string): {
  categories: string[];
  ranges: SecretRange[];
} {
  if (text.length > MAX_RANGE_INPUT_LENGTH) {
    throw new RangeError('secret range input exceeds the allowed length');
  }
  const categories = scanForSecrets(text);
  const found: SecretRange[] = [];
  const ranged: Array<{ category: string; range: RegExp }> = [...SECRET_PATTERNS];
  if (hasAwsKeyPair(text, categories)) {
    ranged.push({ category: 'aws_secret_access_key', range: AWS_BARE_SECRET_RANGE });
  }
  for (const { category, range } of ranged) {
    // matchAll clones the regex, so the module-level lastIndex is never mutated.
    for (const m of text.matchAll(range)) {
      // A value group ends the match: its span is the tail of m[0].
      let end = m.index + m[0].length;
      const start = m[1] !== undefined ? end - m[1].length : m.index;
      if (category === 'pem_private_key') end = findPemEnd(text, end);
      if (end > start) found.push({ start, end });
    }
  }

  found.sort((a, b) => a.start - b.start || a.end - b.end);
  const ranges: SecretRange[] = [];
  for (const r of found) {
    const last = ranges[ranges.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      ranges.push({ ...r });
    }
  }
  return { categories, ranges };
}

/**
 * Asserts that none of the provided string parts contain recognisable secrets.
 *
 * Joins all `parts` with a newline, normalizes the copy (normalizeForScan), then
 * runs `scanForSecrets`. On ANY finding,
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
    // Scan a normalized copy so zero-width / fullwidth characters cannot split a key.
    const text = normalizeForScan(parts.join('\n'));
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
