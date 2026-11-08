/**
 * Pure helpers for the revision history diff (memory detail). Values are
 * turned into plain strings for text-node rendering, never HTML.
 */

export interface FieldChange {
  key: string;
  kind: 'added' | 'removed' | 'changed';
  before: string | null;
  after: string | null;
}

/**
 * Default comparison: previous vs current. `revisions` is newest first (as the
 * detail endpoint returns it); null with fewer than two revisions.
 */
export function defaultRevisionPair(
  revisions: ReadonlyArray<{ revisionNo: number }>,
): { from: number; to: number } | null {
  if (revisions.length < 2) return null;
  return { from: revisions[1].revisionNo, to: revisions[0].revisionNo };
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/** Top-level keys that were added, removed or changed, sorted by key; unchanged keys are omitted. */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldChange[] {
  const has = (o: Record<string, unknown>, k: string): boolean =>
    Object.prototype.hasOwnProperty.call(o, k);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: FieldChange[] = [];
  for (const key of keys) {
    const b = has(before, key) ? asText(before[key]) : null;
    const a = has(after, key) ? asText(after[key]) : null;
    if (b === a) continue;
    out.push({
      key,
      kind: b === null ? 'added' : a === null ? 'removed' : 'changed',
      before: b,
      after: a,
    });
  }
  return out;
}
