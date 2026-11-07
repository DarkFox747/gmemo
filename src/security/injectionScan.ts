// Embedded-instruction detector — pure, no runtime dependencies.
// Flags text that tries to give instructions to an AI agent / judge
// ("ignore previous instructions", "you are now ...", delimiter breaking).
//
// Design: judge-structured-verdict C1, "Sanitize pipeline".
// Contract: scanForInjection() returns CATEGORY NAMES only — never matched text,
//           and nothing in this module logs.
//
// Regex rules: stateless (no `g` flag), no nested quantifiers (linear time),
// case-insensitive. Spanish patterns avoid a trailing `\b` after accented
// letters because `\b` is ASCII-only in JS.
//
// A bare "system prompt" is NOT flagged: this corpus is about LLM tooling, so
// the pattern needs an imperative verb ("reveal the system prompt").

/** Callers (sanitizeItem) bound fields well below this; the guard is a ReDoS backstop. */
const MAX_INPUT_LENGTH = 10_000;

interface InjectionCategory {
  readonly category: string;
  readonly patterns: ReadonlyArray<RegExp>;
}

const INJECTION_CATEGORIES: ReadonlyArray<InjectionCategory> = [
  {
    category: 'ignore_instructions',
    patterns: [
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|rules?|prompts?|messages?)/i,
      /\bdisregard\s+(?:everything\s+|all\s+)?(?:the\s+)?above\b/i,
      /\b(?:ignor|olvid|descart)(?:a|á|e|en|ar|ad)\s+(?:todas\s+|todos\s+)?(?:las\s+|los\s+|tus\s+|sus\s+)?(?:instrucciones|reglas|indicaciones|órdenes)/i,
    ],
  },
  {
    category: 'role_override',
    patterns: [/\byou\s+are\s+now\b/i, /\bahora\s+(?:eres|sos)\s/i],
  },
  {
    category: 'system_prompt',
    patterns: [
      /\b(?:reveal|print|show|output|repeat|ignore|override)\s+(?:the\s+|your\s+)?system\s+prompt\b/i,
      /\bnew\s+system\s+prompt\b/i,
      // `\w` is ASCII-only, so the verb tail is an explicit class (mostrá, muéstrame...).
      /\b(?:revel|mostr|muestr|ignor)[a-záéíóúñ]*\s+(?:el\s+)?prompt\s+del\s+sistema/i,
    ],
  },
  {
    // Tries to break the judge's <gmemo_item>/<gmemo_context> delimiters.
    category: 'delimiter_injection',
    patterns: [/<\s*\/?\s*gmemo_/i],
  },
];

/**
 * Scans `text` for embedded-instruction patterns and returns the matched
 * category names (each at most once, in table order). Never returns or logs
 * the matched text. Empty array means no findings.
 *
 * @throws {RangeError} when `text` exceeds the input bound — callers treat a
 *         throw as a positive (fail-closed), so oversize input is never trusted.
 */
export function scanForInjection(text: string): string[] {
  if (text.length > MAX_INPUT_LENGTH) {
    throw new RangeError('injection scan input exceeds the allowed length');
  }
  const found: string[] = [];
  for (const { category, patterns } of INJECTION_CATEGORIES) {
    if (patterns.some((pattern) => pattern.test(text))) {
      found.push(category);
    }
  }
  return found;
}
