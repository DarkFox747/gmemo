// Span redaction of secrets (C3, HU-10) — pure, no I/O, never logs.
//
// redactSecretSpans replaces each located secret span with REDACTED_TOKEN and
// keeps the surrounding text. finalizeRedaction then clamps to the DB budgets
// and verifies the result: every uncertain branch falls back to whole-field
// (or whole-item) redaction, so the output can only be MORE redacted, never less.
// Correctness does not depend on regex edge cases: isSecretFree is the gate.

import { scanForSecrets, scanForSecretsWithRanges } from './secretScan.js';
import { normalizeForScan } from './normalizeForScan.js';

export const REDACTED_TOKEN = '[REDACTADO]'; // 11 chars — below secret_assignment's 12-char value minimum

/** DB CHECK budgets of title/summary/body (staging_item, quarantine, memory). */
export const TEXT_BUDGET = { title: 120, summary: 200, body: 2000 } as const;

export interface RedactableContent {
  title: string;
  summary: string;
  body: string;
  fields: Record<string, unknown>;
}

/** Whole-item redaction: every text is the sentinel and fields are dropped. */
export const WHOLE_REDACTION: Readonly<RedactableContent> = Object.freeze({
  title: REDACTED_TOKEN,
  summary: REDACTED_TOKEN,
  body: REDACTED_TOKEN,
  fields: Object.freeze({}) as Record<string, unknown>,
});

/** Same depth limit as maskPiiInFields: deeper containers fail closed. */
const MAX_FIELD_DEPTH = 4;

function wholeRedaction(): RedactableContent {
  return { ...WHOLE_REDACTION, fields: {} };
}

/** Replaces every located span right to left (earlier offsets stay valid). */
function redactText(text: string): { text: string; ranges: number } {
  const { ranges } = scanForSecretsWithRanges(text);
  let out = text;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!;
    out = out.slice(0, r.start) + REDACTED_TOKEN + out.slice(r.end);
  }
  return { text: out, ranges: ranges.length };
}

/** Maps every string leaf of a JSON tree; keys are never rewritten. */
function mapLeaves(value: unknown, fn: (leaf: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) {
    if (depth >= MAX_FIELD_DEPTH) throw new RangeError('fields nesting exceeds the allowed depth');
    return value.map((v) => mapLeaves(v, fn, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= MAX_FIELD_DEPTH) throw new RangeError('fields nesting exceeds the allowed depth');
    // fromEntries defines own properties, so a `__proto__` key cannot alter the prototype.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        mapLeaves(v, fn, depth + 1),
      ]),
    );
  }
  return value;
}

/** Every string leaf and every key of a JSON tree (depth-limited). */
function leavesAndKeys(value: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    if (depth >= MAX_FIELD_DEPTH) throw new RangeError('fields nesting exceeds the allowed depth');
    for (const v of value) leavesAndKeys(v, out, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    if (depth >= MAX_FIELD_DEPTH) throw new RangeError('fields nesting exceeds the allowed depth');
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      leavesAndKeys(v, out, depth + 1);
    }
  }
  return out;
}

/**
 * Replaces secret spans in title, summary, body and every string leaf of
 * `fields`. Nothing is clamped yet (PII masking runs in between).
 *
 * @throws {RangeError} on oversize text or fields nested deeper than 4 levels.
 */
export function redactSecretSpans(c: RedactableContent): {
  content: RedactableContent;
  ranges: number;
} {
  let ranges = 0;
  const apply = (text: string): string => {
    const r = redactText(text);
    ranges += r.ranges;
    return r.text;
  };
  const content: RedactableContent = {
    title: apply(c.title),
    summary: apply(c.summary),
    body: apply(c.body),
    fields: mapLeaves(c.fields ?? {}, apply) as Record<string, unknown>,
  };
  return { content, ranges };
}

/**
 * Clamps to `budget`. A cut that would split a sentinel turns the whole field
 * into the sentinel (a half sentinel next to a partial value is never stored).
 */
function clampField(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = budget;
  let p = text.indexOf(REDACTED_TOKEN);
  while (p !== -1 && p < cut) {
    if (cut < p + REDACTED_TOKEN.length) return REDACTED_TOKEN;
    p = text.indexOf(REDACTED_TOKEN, p + 1);
  }
  return text.slice(0, cut);
}

/**
 * Fail-closed finish of a span redaction:
 *  1. no span was located (ranges === 0) → whole item;
 *  2. clamp each text to TEXT_BUDGET (sentinel split → whole field);
 *  3. any secret still detectable → whole item.
 */
export function finalizeRedaction(c: RedactableContent, ranges: number): RedactableContent {
  if (ranges === 0) return wholeRedaction();
  const clamped: RedactableContent = {
    title: clampField(c.title, TEXT_BUDGET.title),
    summary: clampField(c.summary, TEXT_BUDGET.summary),
    body: clampField(c.body, TEXT_BUDGET.body),
    fields: c.fields,
  };
  return isSecretFree(clamped) ? clamped : wholeRedaction();
}

/**
 * True only when no detector fires on any text (each one, and joined), any
 * string leaf or any key of `fields`. Scans normalized copies (like sanitize),
 * so a zero-width split secret is still caught. Any throw counts as false.
 * The texts joined with the fields JSON are scanned too, but secret_assignment is
 * ignored there (each text and leaf was already checked for it): JSON quoting
 * turns a safe `password: [REDACTADO]` leaf into a 12+ char run that would
 * re-match, while a context-anchored detector (aws_secret_access_key) whose
 * context is a fields KEY, or an AWS key id + bare secret pair split across a
 * text and a field, is only visible in the joined unit.
 */
export function isSecretFree(c: RedactableContent): boolean {
  try {
    const units = [
      c.title,
      c.summary,
      c.body,
      `${c.title}\n${c.summary}\n${c.body}`,
      ...leavesAndKeys(c.fields ?? {}),
    ];
    if (!units.every((u) => scanForSecrets(normalizeForScan(u)).length === 0)) return false;
    const joined = normalizeForScan(
      `${c.title}\n${c.summary}\n${c.body}\n${JSON.stringify(c.fields ?? {})}`,
    );
    return scanForSecrets(joined).every((category) => category === 'secret_assignment');
  } catch {
    return false;
  }
}
