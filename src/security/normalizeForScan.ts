// Scan-time normalization — pure, no runtime dependencies.
//
// Detectors run over a normalized COPY of the text so that look-alike
// characters cannot split a pattern: NFKC folds compatibility forms (fullwidth
// letters, ligatures) and every Unicode format character (\p{Cf}: zero-width
// space/joiners, word joiner, soft hyphen, bidi controls) is removed.
// The stored content is never replaced by this copy.

const FORMAT_CHARS = /\p{Cf}/gu;

export function normalizeForScan(text: string): string {
  return text.normalize('NFKC').replace(FORMAT_CHARS, '');
}
