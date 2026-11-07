/**
 * Sanitize stage of the promotion pipeline (design C1, S1–S4). Pure, no I/O,
 * never logs: callers log ids only.
 *
 *   S1 bounds (same caps as capture) or any detector error → block sanitize_failed (redact)
 *   S2 credentials (scanForSecrets)                        → block secret_detected (redact, leak)
 *   S3 embedded instructions (scanForInjection)            → block embedded_instructions
 *   S4 personal data (maskPii / maskPiiInFields)           → masked content, item continues
 *
 * The PII mask is computed even when S3 blocks, so a non-redacted quarantine
 * snapshot never stores raw PII. Text is never truncated before scanning.
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

/** Capture budgets (remember.ts / DB CHECK constraints). */
const BUDGET = { title: 120, summary: 200, body: 2000, fieldsJson: 2000 } as const;

export interface SanitizeContent {
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
}

export interface SanitizeBlock {
  reason: 'secret_detected' | 'embedded_instructions' | 'sanitize_failed';
  redact: boolean;
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
    block: { reason: 'sanitize_failed', redact: true, leak: false, categories: [] },
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
      return {
        flags: { leak: true, secrets },
        masked: null,
        block: { reason: 'secret_detected', redact: true, leak: true, categories: secrets },
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
        ? { reason: 'embedded_instructions', redact: false, leak: false, categories: injection }
        : null;

    return { flags, masked, block };
  } catch {
    // Detector backstops (RangeError on oversize text, fields nested too deep)
    // or any unexpected detector failure: never let unscanned content through.
    return failed();
  }
}

function maskContent(item: SanitizeContent): { masked: SanitizeContent | null; pii: string[] } {
  const title = maskPii(item.title);
  const summary = maskPii(item.summary);
  const body = maskPii(item.body);
  const fields = maskPiiInFields(item.fields ?? {});

  const pii = union(title.categories, summary.categories, body.categories, fields.categories);
  if (pii.length === 0) return { masked: null, pii };

  // Only email can grow (≈1 char per match): clamp back to the DB budgets.
  return {
    masked: {
      title: title.text.slice(0, BUDGET.title),
      summary: summary.text.slice(0, BUDGET.summary),
      body: body.text.slice(0, BUDGET.body),
      fields: fields.fields,
    },
    pii,
  };
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
