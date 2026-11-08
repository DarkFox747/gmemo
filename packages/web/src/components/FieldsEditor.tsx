import { useId } from 'react';
import type { MemoryType } from '../api/types';
import { FIELD_SPECS } from '../lib/labels';

/** Editor values: list fields hold one item per line. */
export type FieldDraft = Record<string, string>;

export function fieldsToDraft(type: MemoryType, fields: Record<string, unknown>): FieldDraft {
  const draft: FieldDraft = {};
  for (const s of FIELD_SPECS[type]) {
    const v = fields[s.key];
    if (Array.isArray(v)) draft[s.key] = v.map(String).join('\n');
    else if (typeof v === 'string') draft[s.key] = v;
    else if (v !== undefined && v !== null) draft[s.key] = JSON.stringify(v);
  }
  return draft;
}

/** Empty inputs are omitted (the server rejects unknown keys only). */
export function draftToFields(type: MemoryType, draft: FieldDraft): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const s of FIELD_SPECS[type]) {
    const raw = (draft[s.key] ?? '').trim();
    if (!raw) continue;
    fields[s.key] =
      s.kind === 'list'
        ? raw
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
        : raw;
  }
  return fields;
}

export function FieldsEditor({
  type,
  draft,
  onChange,
}: {
  type: MemoryType;
  draft: FieldDraft;
  onChange: (d: FieldDraft) => void;
}) {
  const id = useId();
  return (
    <fieldset className="fieldset">
      <legend className="section__label">Campos del tipo</legend>
      {FIELD_SPECS[type].map((s) => (
        <div key={s.key} className="field">
          <label className="field__label" htmlFor={`${id}-${s.key}`}>
            {s.label}
            {s.kind === 'list' && <span className="field__hint"> (uno por línea)</span>}
          </label>
          <textarea
            id={`${id}-${s.key}`}
            className="textarea"
            rows={s.kind === 'list' ? 3 : 2}
            value={draft[s.key] ?? ''}
            onChange={(e) => onChange({ ...draft, [s.key]: e.target.value })}
          />
        </div>
      ))}
    </fieldset>
  );
}
