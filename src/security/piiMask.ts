// Personal-data masking — pure, no runtime dependencies, never logs.
// Masks email, phone and national ids (DNI / CUIT-CUIL) so PII never reaches the
// judge, the embedder or the stored memory.
//
// Design: judge-structured-verdict C1, "Sanitize pipeline".
// Contract: maskPii() returns the masked text plus CATEGORY NAMES only — never
//           the matched text. Masking is idempotent: the tokens never re-match.
//
// Heuristics are intentionally conservative for a technical corpus: protected
// spans (UUIDs, ISO dates, opaque tokens such as handles/ULIDs/SHAs) and
// lookarounds on identifier characters keep versions, IPs, ports, dates and ids
// out of the phone/ID passes. Dots are never phone separators.
//
// Regexes are linear-time on the bounded input: the callers cap the fields
// (<= ~4.3k chars combined) and the guard below is a backstop that throws, so a
// caller's catch turns oversize input into a fail-closed result.

const MAX_INPUT_LENGTH = 10_000;
/** Deepest container nesting walked in `fields`; deeper values fail closed. */
const MAX_FIELD_DEPTH = 4;

const EMAIL_TOKEN = '[EMAIL]';
const PHONE_TOKEN = '[PHONE]';
const ID_TOKEN = '[ID]';

/**
 * `(?<![\w.%+-])` keeps the match at the start of the local part (linear time);
 * `(?!:)` skips scp-style git remotes (`git@github.com:org/repo`). `pnpm@9.15.0`
 * never matches because the TLD must be letters.
 */
const EMAIL_RE = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b(?!:)/g;

/**
 * The trailing `(?![\w-]|\.\w)` rejects glued identifiers, versions and IPs
 * (`1.2.3.4`) but still allows a sentence-ending period.
 */
const CUIT_RE = /(?<![\w.-])(?:20|23|24|27|30|33|34)-?\d{8}-?\d(?![\w-]|\.\w)/g;
const PHONE_RE =
  /(?<![\w.+-])(?:\+\d{1,3}[ -]?)?(?:\(\d{1,4}\)[ -]?)?\d{1,4}(?:[ -]\d{2,4}){1,4}(?![\w-]|\.\w)/g;
const DNI_RE = /(?<![\w.-])\d{7,8}(?![\w-]|\.\w)/g;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_DATE_RE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g;
const OPAQUE_TOKEN_RE = /[A-Za-z0-9_-]{16,}/g;

type Span = readonly [start: number, end: number];

/** Spans of the current text that must not be masked as phone/ID. */
function protectedSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const re of [UUID_RE, ISO_DATE_RE]) {
    for (const m of text.matchAll(re)) {
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  for (const m of text.matchAll(OPAQUE_TOKEN_RE)) {
    // Handles, ULIDs, SHAs and base64url mix letters and digits; a bare number does not.
    if (/[A-Za-z]/.test(m[0]) && /\d/.test(m[0])) {
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  return spans;
}

function overlapsAny(spans: readonly Span[], start: number, end: number): boolean {
  return spans.some(([s, e]) => start < e && end > s);
}

/** Phone candidates need 8-15 digits and a strong phone signal; bare digit groups are not enough. */
function isPhone(match: string): boolean {
  const digits = match.replace(/\D/g, '').length;
  if (digits < 8 || digits > 15) return false;
  const separators = match.match(/[ -]/g)?.length ?? 0;
  return match.startsWith('+') || match.includes('(') || separators >= 2;
}

/** An 8-digit YYYYMMDD date starting with 19/20 is a date, not a DNI. */
function isCompactDate(digits: string): boolean {
  if (!/^(?:19|20)\d{6}$/.test(digits)) return false;
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

interface PassResult {
  text: string;
  masked: boolean;
}

function maskPass(
  text: string,
  re: RegExp,
  token: string,
  accept: (match: string) => boolean,
  guarded: boolean,
): PassResult {
  const spans = guarded ? protectedSpans(text) : [];
  let masked = false;
  const out = text.replace(re, (match: string, offset: number) => {
    if (!accept(match) || overlapsAny(spans, offset, offset + match.length)) return match;
    masked = true;
    return token;
  });
  return { text: out, masked };
}

export interface MaskPiiResult {
  text: string;
  categories: string[];
}

/**
 * Masks email, national ids (CUIT, then DNI) and phones in `text`.
 * Category names are returned in processing order, each at most once.
 *
 * @throws {RangeError} when `text` exceeds the input bound (callers fail closed).
 */
export function maskPii(text: string): MaskPiiResult {
  if (text.length > MAX_INPUT_LENGTH) {
    throw new RangeError('PII mask input exceeds the allowed length');
  }
  const categories: string[] = [];
  const note = (category: string, masked: boolean): void => {
    if (masked && !categories.includes(category)) categories.push(category);
  };

  const email = maskPass(text, EMAIL_RE, EMAIL_TOKEN, () => true, false);
  note('email', email.masked);
  const cuit = maskPass(email.text, CUIT_RE, ID_TOKEN, () => true, true);
  note('national_id', cuit.masked);
  const phone = maskPass(cuit.text, PHONE_RE, PHONE_TOKEN, isPhone, true);
  note('phone', phone.masked);
  const dni = maskPass(phone.text, DNI_RE, ID_TOKEN, (m) => !isCompactDate(m), true);
  note('national_id', dni.masked);

  return { text: dni.text, categories };
}

export interface MaskPiiInFieldsResult {
  fields: Record<string, unknown>;
  categories: string[];
}

/**
 * Masks every string leaf of a JSON `fields` object (keys are never masked;
 * numbers, booleans and null are left alone). The input is not mutated.
 *
 * @throws {RangeError} when containers are nested deeper than 4 levels: failing
 *         closed beats silently leaving unmasked PII in unvisited leaves.
 */
export function maskPiiInFields(fields: Record<string, unknown>): MaskPiiInFieldsResult {
  const categories: string[] = [];

  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') {
      const r = maskPii(value);
      for (const c of r.categories) {
        if (!categories.includes(c)) categories.push(c);
      }
      return r.text;
    }
    if (Array.isArray(value)) {
      if (depth >= MAX_FIELD_DEPTH)
        throw new RangeError('fields nesting exceeds the allowed depth');
      return value.map((v) => walk(v, depth + 1));
    }
    if (value !== null && typeof value === 'object') {
      if (depth >= MAX_FIELD_DEPTH)
        throw new RangeError('fields nesting exceeds the allowed depth');
      // fromEntries defines own properties, so a `__proto__` key cannot alter the prototype.
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, depth + 1)]),
      );
    }
    return value;
  };

  return { fields: walk(fields, 0) as Record<string, unknown>, categories };
}
