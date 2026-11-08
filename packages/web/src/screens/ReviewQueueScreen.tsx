import { useState } from 'react';
import type { MemoryType, QueueFilter, ReviewQueueItemDto } from '../api/types';
import { TypeChip, Chip } from '../components/Chip';
import { ConfidenceBar } from '../components/ConfidenceBar';
import { FilterBar } from '../components/FilterBar';
import { Empty, ErrorMessage, Loading, NoAccess } from '../components/StateViews';
import { formatDateTime, formatOrigin } from '../lib/format';
import { buildHash } from '../lib/hashRoute';
import { criterionShort } from '../lib/labels';
import { useAsync } from '../lib/useAsync';
import type { ScreenProps } from './types';

type FilterKey = 'all' | 'uncertain' | 'mandatory' | 'decision' | 'constraint';

const FILTERS: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'Todas' },
  { key: 'uncertain', label: 'Dudosas' },
  { key: 'mandatory', label: 'Revisión obligatoria' },
  { key: 'decision', label: 'Decisiones' },
  { key: 'constraint', label: 'Restricciones' },
];

const QUERY: Record<FilterKey, { filter: QueueFilter; type?: MemoryType }> = {
  all: { filter: 'all' },
  uncertain: { filter: 'uncertain' },
  mandatory: { filter: 'mandatory' },
  decision: { filter: 'all', type: 'decision' },
  constraint: { filter: 'all', type: 'constraint' },
};

function Motivo({ item }: { item: ReviewQueueItemDto }) {
  if (item.mandatoryReview) return <Chip variant="neutral">Revisión obligatoria</Chip>;
  return (
    <Chip variant="warning">
      Dudosa{item.criterion ? ` · ${criterionShort(item.criterion)}` : ''}
    </Chip>
  );
}

export function ReviewQueueScreen(props: ScreenProps) {
  if (props.role !== 'project_admin') {
    return (
      <>
        <ScreenHeader />
        <NoAccess />
      </>
    );
  }
  return <ReviewQueue {...props} />;
}

function ScreenHeader() {
  return (
    <>
      <h1 className="screen__title" tabIndex={-1}>
        Cola de revisión
      </h1>
      <p className="screen__subtitle">
        Unidades de conocimiento que requieren la decisión del líder técnico antes de incorporarse a
        la memoria compartida.
      </p>
    </>
  );
}

function ReviewQueue({ api, projectId }: ScreenProps) {
  const [filter, setFilter] = useState<FilterKey>('all');
  const state = useAsync(
    () => api.listReviewQueue(projectId, QUERY[filter]),
    [api, projectId, filter],
  );
  const counters = state.data?.counters;

  return (
    <>
      <ScreenHeader />
      <section className="counters" aria-label="Indicadores">
        <Counter label="Pendientes" value={counters?.pending} />
        <Counter label="Dudosas del Juez" value={counters?.uncertain} />
        <Counter label="Revisión obligatoria" value={counters?.mandatory} />
        <Counter label="Resueltas (últimos 7 días)" value={counters?.resolvedLast7Days} accent />
      </section>
      <FilterBar label="Filtrar la cola" options={FILTERS} value={filter} onChange={setFilter} />
      <div className="card card--table">
        {state.status === 'loading' && <Loading />}
        {state.status === 'error' && <ErrorMessage error={state.error} onRetry={state.reload} />}
        {state.status === 'ready' && state.data.items.length === 0 && (
          <Empty text="No hay unidades pendientes de revisión." />
        )}
        {state.status === 'ready' && state.data.items.length > 0 && (
          <table className="table">
            <caption className="visually-hidden">Unidades pendientes de revisión</caption>
            <thead>
              <tr>
                <th scope="col">Tipo</th>
                <th scope="col">Título</th>
                <th scope="col">Motivo</th>
                <th scope="col">Confianza</th>
                <th scope="col">Origen</th>
                <th scope="col">Autor</th>
                <th scope="col">Fecha</th>
                <th scope="col">
                  <span className="visually-hidden">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.data.items.map((it) => (
                <tr key={it.id}>
                  <td>
                    <TypeChip type={it.type} />
                  </td>
                  <td className="cell--title">{it.title}</td>
                  <td>
                    <Motivo item={it} />
                  </td>
                  <td>
                    <ConfidenceBar value={it.confidence} />
                  </td>
                  <td className="mono">{formatOrigin(it.originBranch, it.originPr)}</td>
                  <td>{it.author}</td>
                  <td className="muted">{formatDateTime(it.createdAt)}</td>
                  <td>
                    <a
                      className="btn btn--secondary"
                      href={buildHash({ name: 'reviewDetail', itemId: it.id })}
                      aria-label={`Revisar: ${it.title}`}
                    >
                      Revisar
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {state.status === 'ready' && state.data.truncated && (
          <p className="table__note">Se muestran las 100 más antiguas.</p>
        )}
      </div>
    </>
  );
}

function Counter({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | undefined;
  accent?: boolean;
}) {
  return (
    <div className="card counter">
      <p className="counter__label">{label}</p>
      <p className={accent ? 'counter__value counter__value--accent' : 'counter__value'}>
        {value ?? '—'}
      </p>
    </div>
  );
}
