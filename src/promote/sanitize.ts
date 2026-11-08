/**
 * Sanitize stage of the promotion pipeline (design C1, S1–S4). Pure, no I/O,
 * never logs: callers log ids only.
 *
 *   S1 bounds (same caps as capture) or any detector error → block sanitize_failed (redact 'whole')
 *   S2 credentials (scanForSecrets)                        → block secret_detected (redact 'spans', leak;
 *                                                            'whole' when a PEM private key is found anywhere)
 *   S3 embedded instructions (scanForInjection)            → block embedded_instructions (redact 'none')
 *   S4 personal data (maskPii / maskPiiInFields)           → masked content, item continues
 *
 * The PII mask is computed even when S3 blocks, so a non-redacted quarantine
 * snapshot never stores raw PII. Text is never truncated before scanning.
 *
 * S2 (C3) keeps the text: secret spans are replaced by [REDACTADO] FIRST, then PII
 * is masked (masking could rewrite digits inside a key and leave fragments), then
 * finalizeRedaction clamps and verifies, falling back to whole redaction on any doubt.
 * The safe content is returned in `masked`.
 *
 * S2/S3 scan a normalized COPY (NFKC, format characters stripped) so zero-width
 * or fullwidth characters cannot split a pattern; stored content only changes by
 * the S4 mask. S3 scans each string leaf of `fields` rather than their JSON, whose
 * escapes would hide an instruction split by a newline. Masked fields that grow
 * past the fields budget fail closed (S1) instead of failing later at the DB.
 */

import type { SanitizeFlags } from '../db/promotionRepository.js';
import { scanForSecrets } from '../security/secretScan.js';
import { scanForInjection } from '../security/injectionScan.js';
import { maskPii, maskPiiInFields } from '../security/piiMask.js';
import { normalizeForScan } from '../security/normalizeForScan.js';
import {
  TEXT_BUDGET,
  WHOLE_REDACTION,
  finalizeRedaction,
  redactSecretSpans,
} from '../security/secretRedact.js';
import type { QuarantineRedaction } from '../quarantine/reason.js';

/** Capture budgets (remember.ts / DB CHECK constraints). */
const BUDGET = { ...TEXT_BUDGET, fieldsJson: 2000 } as const;

export interface SanitizeContent {
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
}

export interface SanitizeBlock {
  reason: 'secret_detected' | 'embedded_instructions' | 'sanitize_failed';
  redact: QuarantineRedaction;
  leak: boolean;
  /** Detector category names only, never matched text. */
  categories: string[];
}

export interface SanitizeResult {
  flags: SanitizeFlags;
  /** null = no PII found (content unchanged). */
  masked: SanitizeContent | null;
  block: SanitizeBlock | null;
}

/** S1 result. The caller logs a warning with the item id (never content). */
function failed(): SanitizeResult {
  return {
    flags: {},
    masked: null,
    block: { reason: 'sanitize_failed', redact: 'whole', leak: false, categories: [] },
  };
}

export function sanitizeItem(item: SanitizeContent): SanitizeResult {
  let fieldsJson: string;
  try {
    fieldsJson = JSON.stringify(item.fields ?? {});
  } catch {
    // Unserialisable fields cannot be scanned → fail closed (S1).
    return failed();
  }

  if (
    item.title.length > BUDGET.title ||
    item.summary.length > BUDGET.summary ||
    item.body.length > BUDGET.body ||
    fieldsJson.length > BUDGET.fieldsJson
  ) {
    return failed();
  }

  try {
    const head = `${item.title}\n${item.summary}\n${item.body}`;

    const secrets = scanForSecrets(normalizeForScan(`${head}\n${fieldsJson}`));
    if (secrets.length > 0) {
      if (secrets.includes('pem_private_key')) {
        // SEC-M1: only the PEM header is detectable; the key body may sit in another
        // field (header in title, body in body) where no span covers it → whole item.
        return {
          flags: { leak: true, secrets },
          masked: { ...WHOLE_REDACTION, fields: {} },
          block: { reason: 'secret_detected', redact: 'whole', leak: true, categories: secrets },
        };
      }
      // Spans first, then PII (unclamped), then clamp + verify (fail-closed).
      const redacted = redactSecretSpans(item);
      const pii = maskUnclamped(redacted.content);
      let safe = finalizeRedaction(pii.masked ?? redacted.content, redacted.ranges);
      if (JSON.stringify(safe.fields).length > BUDGET.fieldsJson) {
        // Sentinels can grow fields past the budget: drop them (whole item) rather than fail at the DB.
        safe = { ...WHOLE_REDACTION, fields: {} };
      }
      const flags: SanitizeFlags = { leak: true, secrets };
      if (pii.pii.length > 0) flags.pii = pii.pii;
      return {
        flags,
        masked: safe,
        block: { reason: 'secret_detected', redact: 'spans', leak: true, categories: secrets },
      };
    }

    const leaves = stringLeaves(item.fields ?? {}).join(' ');
    const injection = scanForInjection(normalizeForScan(`${head}\n${leaves}`));
    const { masked, pii } = maskContent(item);
    if (masked && JSON.stringify(masked.fields).length > BUDGET.fieldsJson) {
      return failed();
    }

    const flags: SanitizeFlags = {};
    if (injection.length > 0) flags.injection = injection;
    if (pii.length > 0) flags.pii = pii;

    const block: SanitizeBlock | null =
      injection.length > 0
        ? { reason: 'embedded_instructions', redact: 'none', leak: false, categories: injection }
        : null;

    return { flags, masked, block };
  } catch {
    // Detector backstops (RangeError on oversize text, fields nested too deep)
    // or any unexpected detector failure: never let unscanned content through.
    return failed();
  }
}

/** PII mask of every text and string leaf, without clamping (null = no PII found). */
function maskUnclamped(item: SanitizeContent): { masked: SanitizeContent | null; pii: string[] } {
  const title = maskPii(item.title);
  const summary = maskPii(item.summary);
  const body = maskPii(item.body);
  const fields = maskPiiInFields(item.fields ?? {});

  const pii = union(title.categories, summary.categories, body.categories, fields.categories);
  if (pii.length === 0) return { masked: null, pii };
  return {
    masked: { title: title.text, summary: summary.text, body: body.text, fields: fields.fields },
    pii,
  };
}

/** Only email can grow (≈1 char per match): clamp back to the DB budgets. */
function clampToBudget(c: SanitizeContent): SanitizeContent {
  return {
    title: c.title.slice(0, BUDGET.title),
    summary: c.summary.slice(0, BUDGET.summary),
    body: c.body.slice(0, BUDGET.body),
    fields: c.fields,
  };
}

function maskContent(item: SanitizeContent): { masked: SanitizeContent | null; pii: string[] } {
  const r = maskUnclamped(item);
  return { masked: r.masked ? clampToBudget(r.masked) : null, pii: r.pii };
}

/** Every string value of a JSON-like tree, depth-first (keys are policy-validated). */
function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) stringLeaves(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) stringLeaves(v, out);
  }
  return out;
}

function union(...lists: Array<readonly string[] | undefined>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const c of list ?? []) if (!out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Union of persisted and fresh flags. Without it a re-run on already-masked
 * text would drop `pii`. Empty category lists are omitted.
 */
export function mergeFlags(
  persisted: SanitizeFlags | null | undefined,
  fresh: SanitizeFlags,
): SanitizeFlags {
  const a = persisted ?? {};
  const out: SanitizeFlags = {};
  if (a.leak || fresh.leak) out.leak = true;
  for (const key of ['secrets', 'injection', 'pii'] as const) {
    const merged = union(a[key], fresh[key]);
    if (merged.length > 0) out[key] = merged;
  }
  return out;
}
