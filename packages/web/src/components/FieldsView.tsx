import type { MemoryType } from '../api/types';
import { FIELD_SPECS } from '../lib/labels';

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' · ');
  }
  return JSON.stringify(v);
}

/** Read-only typed fields, always rendered as text; unknown keys keep their raw key as label. */
export function FieldsView({
  type,
  fields,
}: {
  type: MemoryType;
  fields: Record<string, unknown>;
}) {
  const specs = FIELD_SPECS[type];
  const present = (k: string): boolean => fields[k] !== undefined && fields[k] !== null;
  const rows = [
    ...specs.filter((s) => present(s.key)).map((s) => ({ key: s.key, label: s.label })),
    ...Object.keys(fields)
      .filter((k) => present(k) && !specs.some((s) => s.key === k))
      .map((k) => ({ key: k, label: k })),
  ];
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map((r) => (
        <div key={r.key} className="section">
          <h3 className="section__label">{r.label}</h3>
          <p className="section__box">{asText(fields[r.key])}</p>
        </div>
      ))}
    </>
  );
}
