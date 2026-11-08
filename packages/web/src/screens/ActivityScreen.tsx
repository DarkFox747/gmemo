import { useState } from 'react';
import { ACTIVITY_CATEGORIES } from '../api/types';
import type { ActivityCategory, ActivityEventDto } from '../api/types';
import { TypeChip } from '../components/Chip';
import { FilterBar } from '../components/FilterBar';
import type { FilterOption } from '../components/FilterBar';
import { Empty, ErrorMessage, Loading, NoAccess } from '../components/StateViews';
import { formatDateTime } from '../lib/format';
import { activityFactsText, actorText } from '../lib/insights';
import { activityActionLabel, activityCategoryLabel } from '../lib/labels';
import { useAsync } from '../lib/useAsync';
import type { ScreenProps } from './types';

type Filter = 'all' | ActivityCategory;

const FILTERS: ReadonlyArray<FilterOption<Filter>> = [
  { key: 'all', label: 'Todas' },
  ...ACTIVITY_CATEGORIES.map((c) => ({ key: c, label: activityCategoryLabel(c) })),
];

function Header() {
  return (
    <>
      <h1 className="screen__title" tabIndex={-1}>
        Actividad
      </h1>
      <p className="screen__subtitle">
        Registro de auditoría del proyecto: propuestas de agentes, promociones, revisiones,
        restauraciones, cambios directos y tareas de la plataforma. Las lecturas no se listan y
        nunca se muestra contenido más allá de los títulos.
      </p>
    </>
  );
}

export function ActivityScreen(props: ScreenProps) {
  if (props.role !== 'project_admin') {
    return (
      <>
        <Header />
        <NoAccess />
      </>
    );
  }
  return <Activity {...props} />;
}

function Activity({ api, projectId }: ScreenProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const category = filter === 'all' ? undefined : filter;
  const first = useAsync(
    () => api.listActivity(projectId, { category }),
    [api, projectId, category],
  );
  // Extra pages appended by "Cargar más"; reset whenever the first page reloads.
  const [more, setMore] = useState<{
    key: unknown;
    items: ActivityEventDto[];
    cursor: string | null;
  }>({ key: null, items: [], cursor: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);

  const pageKey = first.data;
  const appended = more.key === pageKey ? more : { key: pageKey, items: [], cursor: null };
  const items = first.status === 'ready' ? [...first.data.items, ...appended.items] : [];
  const nextCursor =
    first.status === 'ready'
      ? appended.items.length > 0
        ? appended.cursor
        : first.data.nextCursor
      : null;

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.listActivity(projectId, { category, cursor: nextCursor });
      setMore({ key: pageKey, items: [...appended.items, ...page.items], cursor: page.nextCursor });
    } catch (err) {
      console.error('[activity] load more failed', err);
      setMoreError(err);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <Header />
      <div className="toolbar">
        <FilterBar label="Categoría" options={FILTERS} value={filter} onChange={setFilter} />
        <div className="toolbar__actions">
          <button type="button" className="btn btn--secondary" onClick={first.reload}>
            Actualizar
          </button>
        </div>
      </div>
      <div className="card card--table">
        {first.status === 'loading' && <Loading />}
        {first.status === 'error' && <ErrorMessage error={first.error} onRetry={first.reload} />}
        {first.status === 'ready' && items.length === 0 && (
          <Empty text="No hay actividad registrada con este filtro." />
        )}
        {first.status === 'ready' && items.length > 0 && (
          <table className="table">
            <caption className="visually-hidden">Actividad del proyecto</caption>
            <thead>
              <tr>
                <th scope="col">Fecha</th>
                <th scope="col">Actor</th>
                <th scope="col">Acción</th>
                <th scope="col">Objeto</th>
                <th scope="col">Detalle</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td className="muted nowrap">{formatDateTime(e.at)}</td>
                  <td>{actorText(e.actor)}</td>
                  <td className="cell--title">{activityActionLabel(e.action)}</td>
                  <td>
                    {e.target ? (
                      <span className="target">
                        <TypeChip type={e.target.type} />
                        <span>{e.target.title}</span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="muted small">{activityFactsText(e.facts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {moreError !== null && <ErrorMessage error={moreError} onRetry={loadMore} />}
        {nextCursor && (
          <div className="table__more">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? 'Cargando…' : 'Cargar más'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
