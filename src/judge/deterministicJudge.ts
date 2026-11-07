/**
 * ⚠️  DEV/TEST-ONLY JUDGE — NEVER SELECTED IN PRODUCTION.  ⚠️
 *
 * DeterministicJudge applies ordered, documented heuristics (C1 design, D3).
 * It is chosen at the composition root ONLY when JUDGE_STUB=true AND
 * NODE_ENV !== 'production'; config.loadConfig() fails fast on that pairing.
 *
 * Pure: the same (item, context) always yields the same result. Rules are
 * evaluated in order and the FIRST match wins. The C8 demo script relies on
 * this table, so changing it is a spec change.
 *
 * | # | Rule                                                        | Verdict / criterion            | Confidence         | related |
 * |---|-------------------------------------------------------------|--------------------------------|--------------------|---------|
 * | 1 | title/summary/body disclose a credential in natural language | rejected / security_second_layer | 0.95             | null    |
 * |   | ("password is …", "contraseña es …") or an encoded-blob hint |                                |                    |         |
 * |   | ("base64: <32+ chars>")                                      |                                |                    |         |
 * | 2 | body.trim() < 20 chars, or < 3 body tokens, or a generic     | rejected / specificity         | 0.9                | null    |
 * |   | title (note, todo, fix, update, misc, wip, test, stuff)      |                                |                    |         |
 * | 3 | a context memory (any type) has the same normTitle           | rejected / duplication         | 0.95               | its id  |
 * | 4 | a same-type context memory with a different normTitle shares | uncertain / contradiction      | 0.7                | its id  |
 * |   | ≥ 3 title tokens and jaccard ≥ 0.6                           |                                |                    |         |
 * | 5 | gotcha / integration_note whose body has no concrete artefact | uncertain / grounding         | 0.6                | null    |
 * |   | (path, file.ext, `code`, UPPER_SNAKE, call(), URL)           |                                |                    |         |
 * | 6 | body has a hedge term (maybe, probably, creo que, …)         | accepted / confidence          | 0.6 (fixed)        | null    |
 * | 7 | default                                                      | accepted / confidence          | acceptedConfidence | null    |
 *
 * Helpers:
 *  - normTitle(s): lowercase, each [^a-z0-9áéíóúñü] → space, collapse whitespace, trim.
 *  - tokens(s): words of normTitle(s) with length ≥ 3, minus STOPWORDS, as a Set.
 *  - jaccard(a, b) = |a∩b| / |a∪b|.
 *
 * Rule 1 deliberately does NOT duplicate the pipeline detectors (secretScan /
 * injectionScan): it catches what they miss, so the second layer is reachable.
 * Reasons are fixed strings and never echo item content.
 *
 * // DEV-ONLY
 */
import type { Judge, JudgeContextItem, JudgeItem, JudgeResult } from './judge.js';

// All regexes are stateless (no `g`) and free of nested quantifiers.
const CREDENTIAL_DISCLOSURE =
  /\b(?:password|passwd|pwd|passphrase|contraseña|clave)\s+(?:is|was|es|era)\s+["']?[^\s"']{4,}/i;
const ENCODED_BLOB = /\b(?:base64|b64)\s*[:=]?\s*[A-Za-z0-9+/]{32,}={0,2}/i;

const GENERIC_TITLES: ReadonlySet<string> = new Set([
  'note',
  'todo',
  'fix',
  'update',
  'misc',
  'wip',
  'test',
  'stuff',
]);

const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'are',
  'was',
  'los',
  'las',
  'del',
  'que',
  'por',
  'con',
  'una',
  'para',
]);

const ARTEFACT_PATTERNS: readonly RegExp[] = [
  /[\w.-]+\/[\w./-]+/, // path with a slash
  /\b[\w-]+\.(?:ts|js|mjs|cjs|json|sql|md|ya?ml|tf|py|go|java|sh|toml|env)\b/, // file with extension
  /`[^`\n]{2,}`/, // backticked code
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, // UPPER_SNAKE identifier
  /\b\w+\(\)/, // call
  /https?:\/\/\S+/, // URL
];

const GROUNDED_TYPES: ReadonlySet<JudgeItem['type']> = new Set(['gotcha', 'integration_note']);

const HEDGE_EN = /\b(?:maybe|probably|might|perhaps|not sure|i think|unverified|untested)\b/i;
// No trailing \b: JS \b is ASCII-only and would fail after accented letters.
const HEDGE_ES = /(?:tal vez|quizás|quizas|creo que|no estoy seguro)/i;

function normTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): Set<string> {
  const words = normTitle(s).split(' ');
  return new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const inter = intersectionSize(a, b);
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function result(
  verdict: JudgeResult['verdict'],
  criterion: JudgeResult['criterion'],
  confidence: number,
  reason: string,
  relatedMemoryId: string | null = null,
): JudgeResult {
  return { verdict, criterion, confidence, reason, relatedMemoryId };
}

export interface DeterministicJudgeOptions {
  /** Confidence of rule-7 (default) accepts — from JUDGE_STUB_CONFIDENCE. */
  acceptedConfidence: number;
}

export class DeterministicJudge implements Judge {
  private readonly acceptedConfidence: number;

  constructor({ acceptedConfidence }: DeterministicJudgeOptions) {
    this.acceptedConfidence = acceptedConfidence;
  }

  async evaluate(item: JudgeItem, context: readonly JudgeContextItem[]): Promise<JudgeResult> {
    // Rule 1 — natural-language credential disclosure / encoded blob.
    const text = `${item.title}\n${item.summary}\n${item.body}`;
    if (CREDENTIAL_DISCLOSURE.test(text) || ENCODED_BLOB.test(text)) {
      return result(
        'rejected',
        'security_second_layer',
        0.95,
        'Item appears to disclose a credential or an encoded secret.',
      );
    }

    // Rule 2 — not specific enough.
    const title = normTitle(item.title);
    if (item.body.trim().length < 20 || tokens(item.body).size < 3 || GENERIC_TITLES.has(title)) {
      return result(
        'rejected',
        'specificity',
        0.9,
        'Item is too generic or short to be actionable.',
      );
    }

    // Rule 3 — same normalised title as a context memory (any type).
    const duplicate = context.find((c) => normTitle(c.title) === title);
    if (duplicate) {
      return result(
        'rejected',
        'duplication',
        0.95,
        'Item restates an existing active memory.',
        duplicate.id,
      );
    }

    // Rule 4 — near-identical same-type title with a different wording.
    const titleTokens = tokens(item.title);
    const conflicting = context.find((c) => {
      if (c.type !== item.type) return false;
      const other = tokens(c.title);
      return intersectionSize(titleTokens, other) >= 3 && jaccard(titleTokens, other) >= 0.6;
    });
    if (conflicting) {
      return result(
        'uncertain',
        'contradiction',
        0.7,
        'Item may conflict with a similar existing memory of the same type.',
        conflicting.id,
      );
    }

    // Rule 5 — gotcha / integration_note without a concrete artefact reference.
    if (GROUNDED_TYPES.has(item.type) && !ARTEFACT_PATTERNS.some((p) => p.test(item.body))) {
      return result(
        'uncertain',
        'grounding',
        0.6,
        'Item makes claims without a concrete artefact reference.',
      );
    }

    // Rule 6 — hedged language: accepted but below the default threshold.
    if (HEDGE_EN.test(item.body) || HEDGE_ES.test(item.body)) {
      return result(
        'accepted',
        'confidence',
        0.6,
        'Item uses hedged language; confidence is limited.',
      );
    }

    // Rule 7 — default.
    return result(
      'accepted',
      'confidence',
      this.acceptedConfidence,
      'Item passed all heuristic checks.',
    );
  }
}
