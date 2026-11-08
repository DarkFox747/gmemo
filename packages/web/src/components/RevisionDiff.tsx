import { useId, useState } from 'react';
import type { MemoryRevisionDto } from '../api/types';
import { formatDateTime } from '../lib/format';
import { REVISION_DIFF, typeLabel } from '../lib/labels';
import { defaultRevisionPair, diffFields } from '../lib/revisionDiff';
import { addedSide, removedSide, wordDiff } from '../lib/wordDiff';
import type { DiffSegment } from '../lib/wordDiff';
import { DiffSegments } from './DiffSegments';

function Text({ label, segs }: { label: string; segs: DiffSegment[] }) {
  return (
    <>
      <h4 className="section__label">{label}</h4>
      <p className="compare__text">
        <DiffSegments segs={segs} />
      </p>
    </>
  );
}

/**
 * Two-revision picker + word-level diff of title, summary and body, a type
 * change row and a key-by-key fields diff. Text nodes only. Renders nothing
 * with fewer than two revisions. `revisions` is newest first.
 */
export function RevisionDiff({ revisions }: { revisions: MemoryRevisionDto[] }) {
  const id = useId();
  const initial = defaultRevisionPair(revisions);
  const [from, setFrom] = useState(initial?.from ?? 0);
  const [to, setTo] = useState(initial?.to ?? 0);
  if (!initial) return null;

  const older = revisions.find((r) => r.revisionNo === from);
  const newer = revisions.find((r) => r.revisionNo === to);

  const picker = (label: string, value: number, onChange: (n: number) => void, key: string) => (
    <div className="field">
      <label className="field__label" htmlFor={`${id}-${key}`}>
        {label}
      </label>
      <select
        id={`${id}-${key}`}
        className="select"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {revisions.map((r) => (
          <option key={r.revisionNo} value={r.revisionNo}>
            {REVISION_DIFF.option(r.revisionNo, formatDateTime(r.createdAt))}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="revision-diff">
      <div className="revision-diff__pickers">
        {picker(REVISION_DIFF.from, from, setFrom, 'from')}
        {picker(REVISION_DIFF.to, to, setTo, 'to')}
      </div>
      {!older || !newer || from === to ? (
        <p className="muted" role="status">
          {REVISION_DIFF.sameVersion}
        </p>
      ) : (
        <DiffBody older={older} newer={newer} />
      )}
    </div>
  );
}

function DiffBody({ older, newer }: { older: MemoryRevisionDto; newer: MemoryRevisionDto }) {
  const title = wordDiff(older.title, newer.title);
  const summary = wordDiff(older.summary, newer.summary);
  const body = wordDiff(older.body, newer.body);
  const fields = diffFields(older.fields, newer.fields);
  return (
    <>
      <div className="compare">
        <div className="compare__col">
          <h3 className="compare__title">{REVISION_DIFF.version(older.revisionNo)}</h3>
          <Text label={REVISION_DIFF.titleField} segs={removedSide(title)} />
          <Text label={REVISION_DIFF.summary} segs={removedSide(summary)} />
          <Text label={REVISION_DIFF.body} segs={removedSide(body)} />
        </div>
        <div className="compare__col">
          <h3 className="compare__title">{REVISION_DIFF.version(newer.revisionNo)}</h3>
          <Text label={REVISION_DIFF.titleField} segs={addedSide(title)} />
          <Text label={REVISION_DIFF.summary} segs={addedSide(summary)} />
          <Text label={REVISION_DIFF.body} segs={addedSide(body)} />
        </div>
      </div>
      {older.type !== newer.type && (
        <p>
          <strong>{REVISION_DIFF.type}:</strong>{' '}
          <mark className="diff--removed">
            <span className="visually-hidden">{REVISION_DIFF.srRemoved}</span>
            {typeLabel(older.type)}
          </mark>{' '}
          →{' '}
          <mark className="diff--added">
            <span className="visually-hidden">{REVISION_DIFF.srAdded}</span>
            {typeLabel(newer.type)}
          </mark>
        </p>
      )}
      <h4 className="section__label">{REVISION_DIFF.fields}</h4>
      {fields.length === 0 ? (
        <p className="muted">{REVISION_DIFF.noFieldChanges}</p>
      ) : (
        <ul className="revision-diff__fields">
          {fields.map((f) => {
            const segs = f.before !== null && f.after !== null ? wordDiff(f.before, f.after) : null;
            return (
              <li key={f.key}>
                <p>
                  <span className="mono">{f.key}</span>{' '}
                  <span className="muted small">({REVISION_DIFF.fieldKind[f.kind]})</span>
                </p>
                <div className="compare">
                  <p className="compare__text">
                    {segs ? (
                      <DiffSegments segs={removedSide(segs)} />
                    ) : (
                      f.before !== null && (
                        <mark className="diff--removed">
                          <span className="visually-hidden">{REVISION_DIFF.srRemoved}</span>
                          {f.before}
                        </mark>
                      )
                    )}
                  </p>
                  <p className="compare__text">
                    {segs ? (
                      <DiffSegments segs={addedSide(segs)} />
                    ) : (
                      f.after !== null && (
                        <mark className="diff--added">
                          <span className="visually-hidden">{REVISION_DIFF.srAdded}</span>
                          {f.after}
                        </mark>
                      )
                    )}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small">{REVISION_DIFF.whitespaceNote}</p>
    </>
  );
}
