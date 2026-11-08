/**
 * Word-level diff (LCS over whitespace-split tokens) for the proposal vs
 * related-unit comparison. Output is plain text segments: callers render them
 * as text nodes, never as HTML.
 */

export type DiffKind = 'same' | 'added' | 'removed';
export interface DiffSegment {
  text: string;
  kind: DiffKind;
}

/** Above this many tokens per side the O(n*m) table is skipped: everything differs. */
export const MAX_DIFF_TOKENS = 400;

const tokenize = (s: string): string[] => s.split(/\s+/).filter((t) => t.length > 0);

/** Merge consecutive tokens of the same kind into one space-joined segment. */
function push(out: DiffSegment[], text: string, kind: DiffKind): void {
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += ` ${text}`;
  else out.push({ text, kind });
}

export function wordDiff(before: string, after: string): DiffSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const out: DiffSegment[] = [];

  if (a.length > MAX_DIFF_TOKENS || b.length > MAX_DIFF_TOKENS) {
    if (a.length > 0) out.push({ text: a.join(' '), kind: 'removed' });
    if (b.length > 0) out.push({ text: b.join(' '), kind: 'added' });
    return out;
  }

  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(out, a[i], 'same');
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push(out, a[i++], 'removed');
    } else {
      push(out, b[j++], 'added');
    }
  }
  while (i < a.length) push(out, a[i++], 'removed');
  while (j < b.length) push(out, b[j++], 'added');
  return out;
}

/** Segments for the left side (related unit): unchanged + removed words. */
export const removedSide = (segs: DiffSegment[]): DiffSegment[] =>
  segs.filter((s) => s.kind !== 'added');

/** Segments for the right side (proposal): unchanged + added words. */
export const addedSide = (segs: DiffSegment[]): DiffSegment[] =>
  segs.filter((s) => s.kind !== 'removed');
