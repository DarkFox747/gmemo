import type { DiffSegment } from '../lib/wordDiff';

/** Segments as text nodes; changed words get a class, never markup from the server. */
export function DiffSegments({ segs }: { segs: DiffSegment[] }) {
  return (
    <>
      {segs.map((s, i) => (
        <span key={i}>
          {i > 0 && ' '}
          {s.kind === 'same' ? (
            s.text
          ) : (
            <mark className={`diff--${s.kind}`}>
              {s.text}
              <span className="visually-hidden">
                {s.kind === 'added' ? ' (añadido)' : ' (eliminado)'}
              </span>
            </mark>
          )}
        </span>
      ))}
    </>
  );
}
