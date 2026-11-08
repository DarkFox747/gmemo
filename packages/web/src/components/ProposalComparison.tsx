import type { MemoryRefDto } from '../api/types';
import { addedSide, removedSide, wordDiff } from '../lib/wordDiff';
import type { DiffSegment } from '../lib/wordDiff';

interface Proposal {
  title: string;
  summary: string;
}

/** Segments as text nodes; changed words get a class, never markup from the server. */
function Segments({ segs }: { segs: DiffSegment[] }) {
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

function Field({ label, segs }: { label: string; segs: DiffSegment[] }) {
  return (
    <>
      <h4 className="section__label">{label}</h4>
      <p className="compare__text">
        <Segments segs={segs} />
      </p>
    </>
  );
}

/** Related unit (left, removed words) vs proposal (right, added words). The related DTO carries no body. */
export function ProposalComparison({
  proposal,
  related,
}: {
  proposal: Proposal;
  related: MemoryRefDto;
}) {
  const title = wordDiff(related.title, proposal.title);
  const summary = wordDiff(related.summary, proposal.summary);
  return (
    <div className="compare">
      <div className="compare__col">
        <h3 className="compare__title">Unidad relacionada (v{related.version})</h3>
        <Field label="Título" segs={removedSide(title)} />
        <Field label="Resumen" segs={removedSide(summary)} />
      </div>
      <div className="compare__col">
        <h3 className="compare__title">Propuesta</h3>
        <Field label="Título" segs={addedSide(title)} />
        <Field label="Resumen" segs={addedSide(summary)} />
      </div>
    </div>
  );
}
