// Scan-time normalization — pure, no runtime dependencies.
//
// Detectors run over a normalized COPY of the text so that look-alike
// characters cannot split a pattern: NFKC folds compatibility forms (fullwidth
// letters, ligatures) and every Unicode format character (\p{Cf}: zero-width
// space/joiners, word joiner, soft hyphen, bidi controls) is removed, as are the
// invisible characters outside \p{Cf}: combining grapheme joiner (U+034F),
// Hangul fillers (U+115F, U+1160, U+3164; NFKC maps U+FFA0 to U+1160), the
// blank Braille pattern (U+2800) and variation selectors (U+FE00–U+FE0F).
// The stored content is never replaced by this copy.

// Combining marks (U+034F, variation selectors) stay outside any multi-char class
// (no-misleading-character-class): each is its own alternative.
const INVISIBLE_CHARS = /\p{Cf}|[\u115F\u1160\u3164\u2800]|\u034F|[\uFE00-\uFE0F]/gu;

export function normalizeForScan(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE_CHARS, '');
}
