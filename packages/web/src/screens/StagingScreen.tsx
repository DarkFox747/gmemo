import { useState } from 'react';
import type { StagingItemState, StagingSessionDto } from '../api/types';
import { Chip, TypeChip } from '../components/Chip';
import { Empty, ErrorMessage, Loading, NoAccess } from '../components/StateViews';
import { formatDateTime, formatOrigin } from '../lib/format';
import {
  criterionShort,
  judgeStateLabel,
  opLabel,
  sessionStatusLabel,
  stagingItemStateLabel,
} from '../lib/labels';
import { useAsync } from '../lib/useAsync';
import type { ScreenProps } from './types';

type Tab = 'open' | 'closed';

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'open', label: 'Abiertas' },
  { key: 'closed', label: 'Cerradas (7 días)' },
];

/** Chip variant per item state (existing .chip--* classes). */
const STATE_VARIANT: Record<StagingItemState, string> = {
  staged: 'neutral',
  queued: 'warning',
  applied: 'active',
  quarantined: 'reason',
  review_rejected: 'reason',
};

function Header() {
  return (
    <>
      <h1 className="screen__title" tabIndex={-1}>
        Área de preparación
      </h1>
      <p className="screen__subtitle">
        Lo que los agentes propusieron en cada rama antes del merge. Vista de solo lectura: las
        propuestas se promueven al hacer merge de la PR o se descartan al cerrarla.
      </p>
    </>
  );
}

export function StagingScreen(props: ScreenProps) {
  if (props.role !== 'project_admin') {
    return (
      <>
        <Header />
        <NoAccess />
      </>
    );
  }
  return <Staging {...props} />;
}

function Staging({ api, projectId }: ScreenProps) {
  const [tab, setTab] = useState<Tab>('open');
  const state = useAsync(() => api.listStaging(projectId, { status: tab }), [api, projectId, tab]);

  return (
    <>
      <Header />
      <div className="toolbar">
        <div role="tablist" aria-label="Sesiones" className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="toolbar__actions">
          <button type="button" className="btn btn--secondary" onClick={state.reload}>
            Actualizar
          </button>
        </div>
      </div>
      <div role="tabpanel" className="stack">
        {state.status === 'loading' && <Loading />}
        {state.status === 'error' && <ErrorMessage error={state.error} onRetry={state.reload} />}
        {state.status === 'ready' && state.data.sessions.length === 0 && (
          <div className="card">
            <Empty
              text={
                tab === 'open'
                  ? 'No hay sesiones de preparación abiertas.'
                  : 'No se cerró ninguna sesión en los últimos 7 días.'
              }
            />
          </div>
        )}
        {state.status === 'ready' &&
          state.data.sessions.map((s) => <SessionCard key={s.id} s={s} />)}
        {state.status === 'ready' && state.data.truncated && (
          <p className="footnote">Se muestran solo las sesiones más recientes.</p>
        )}
      </div>
    </>
  );
}

function SessionCard({ s }: { s: StagingSessionDto }) {
  const headingId = `session-${s.id}`;
  return (
    <section className="card session-card" aria-labelledby={headingId}>
      <div className="card__head">
        <h2 id={headingId} className="card__title mono">
          {formatOrigin(s.branch, s.prNumber)}
        </h2>
        <Chip variant={s.status === 'open' ? 'active' : 'neutral'}>
          {sessionStatusLabel(s.status)}
        </Chip>
      </div>
      <p className="muted small session-card__meta">
        <span className="mono">{s.repo.label}</span>
        {' · '}Abierta por {s.openedBy ?? 'Usuario sin nombre'}
        {' · '}Última actividad: {formatDateTime(s.lastActivityAt)}
        {' · '}
        {s.closedAt
          ? `Cerrada: ${formatDateTime(s.closedAt)}`
          : s.expiresAt
            ? `Vence: ${formatDateTime(s.expiresAt)}`
            : 'Sin vencimiento'}
        {' · '}
        {s.itemCount === 1 ? '1 propuesta' : `${s.itemCount} propuestas`}
      </p>
      {s.items.length === 0 ? (
        <Empty text="La sesión no tiene propuestas." />
      ) : (
        <table className="table">
          <caption className="visually-hidden">Propuestas de {s.branch}</caption>
          <thead>
            <tr>
              <th scope="col">Tipo</th>
              <th scope="col">Título</th>
              <th scope="col">Operación</th>
              <th scope="col">Juez</th>
              <th scope="col">Estado</th>
            </tr>
          </thead>
          <tbody>
            {s.items.map((i) => (
              <tr key={i.id}>
                <td>
                  <TypeChip type={i.type} />
                </td>
                <td>
                  <p className="cell--title">{i.title}</p>
                  {i.mandatoryReview && <p className="muted small">Revisión obligatoria</p>}
                </td>
                <td>{opLabel(i.op)}</td>
                <td>
                  {judgeStateLabel(i.judgeState)}
                  {i.criterion && (
                    <span className="muted small"> · {criterionShort(i.criterion)}</span>
                  )}
                </td>
                <td>
                  <Chip variant={STATE_VARIANT[i.state]}>{stagingItemStateLabel(i.state)}</Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {s.itemsTruncated && (
        <p className="footnote">Se muestran las 100 propuestas más recientes de {s.itemCount}.</p>
      )}
    </section>
  );
}
