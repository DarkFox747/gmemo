import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage } from '../api/client';
import { MEMORY_TYPES } from '../api/types';
import type { MemoryListItemDto, MemoryType } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { RetireDialog } from '../components/RetireDialog';
import { StatusChip, TypeChip } from '../components/Chip';
import { Empty, ErrorMessage, Loading, NoAccess } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { formatDate, formatDateTime, formatOrigin } from '../lib/format';
import { buildHash } from '../lib/hashRoute';
import { typeLabel } from '../lib/labels';
import { useAsync } from '../lib/useAsync';
import type { ScreenProps } from './types';

type Tab = 'active' | 'pending_revalidation';

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'active', label: 'Activas' },
  { key: 'pending_revalidation', label: 'Pendientes de revalidación' },
];

function Header() {
  return (
    <>
      <h1 className="screen__title" tabIndex={-1}>
        Memoria del proyecto
      </h1>
      <p className="screen__subtitle">
        Unidades incorporadas a la memoria compartida. Las pendientes de revalidación superaron su
        plazo y esperan que el líder técnico las confirme o las retire.
      </p>
    </>
  );
}

export function MemoryScreen(props: ScreenProps) {
  if (props.role !== 'project_admin') {
    return (
      <>
        <Header />
        <NoAccess />
      </>
    );
  }
  return <MemoryList {...props} />;
}

function MemoryList({ api, projectId }: ScreenProps) {
  const toast = useToast();
  const id = useId();
  const [tab, setTab] = useState<Tab>('active');
  const [type, setType] = useState<MemoryType | ''>('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const first = useAsync(
    () => api.listMemories(projectId, { status: tab, type: type || undefined, q: query }),
    [api, projectId, tab, type, query],
  );
  // Extra pages appended by "Cargar más"; reset whenever the first page reloads.
  const [more, setMore] = useState<{
    key: unknown;
    items: MemoryListItemDto[];
    cursor: string | null;
  }>({
    key: null,
    items: [],
    cursor: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);

  const [retiring, setRetiring] = useState<MemoryListItemDto | null>(null);
  const [byPrOpen, setByPrOpen] = useState(false);
  const [byPrStep, setByPrStep] = useState<{ pr: number; reason: string } | null>(null);
  const [byPrPr, setByPrPr] = useState('');
  const [byPrReason, setByPrReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

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
      const page = await api.listMemories(projectId, {
        status: tab,
        type: type || undefined,
        q: query,
        cursor: nextCursor,
      });
      setMore({ key: pageKey, items: [...appended.items, ...page.items], cursor: page.nextCursor });
    } catch (err) {
      console.error('[memory] load more failed', err);
      setMoreError(err);
    } finally {
      setLoadingMore(false);
    }
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setDialogError(null);
    try {
      await action();
      first.reload();
    } catch (err) {
      console.error('[memory] action failed', err);
      setDialogError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function confirm(m: MemoryListItemDto): void {
    void run(async () => {
      await api.confirmMemory(projectId, m.id);
      toast('Unidad confirmada; vuelve a estar activa');
    });
  }

  function submitSearch(e: FormEvent): void {
    e.preventDefault();
    setQuery(search.trim());
  }

  function submitByPr(e: FormEvent): void {
    e.preventDefault();
    const pr = Number(byPrPr);
    const reason = byPrReason.trim();
    if (!Number.isInteger(pr) || pr <= 0 || reason.length < 3 || reason.length > 500) {
      setDialogError('Indica un número de PR válido y un motivo de entre 3 y 500 caracteres.');
      return;
    }
    setDialogError(null);
    setByPrOpen(false);
    setByPrStep({ pr, reason });
  }

  return (
    <>
      <Header />
      <div className="toolbar">
        <div role="tablist" aria-label="Estado" className="tabs">
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
          <a className="btn btn--primary" href={buildHash({ name: 'memoryNew' })}>
            + Nueva unidad
          </a>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              setDialogError(null);
              setByPrPr('');
              setByPrReason('');
              setByPrOpen(true);
            }}
          >
            Retirar por PR
          </button>
        </div>
      </div>
      <form className="filters filters--form" onSubmit={submitSearch} role="search">
        <label className="field__label" htmlFor={`${id}-type`}>
          Tipo
        </label>
        <select
          id={`${id}-type`}
          className="select"
          value={type}
          onChange={(e) => setType(e.target.value as MemoryType | '')}
        >
          <option value="">Todos los tipos</option>
          {MEMORY_TYPES.map((t) => (
            <option key={t} value={t}>
              {typeLabel(t)}
            </option>
          ))}
        </select>
        <label className="field__label" htmlFor={`${id}-q`}>
          Buscar
        </label>
        <input
          id={`${id}-q`}
          type="search"
          className="input input--search"
          maxLength={200}
          placeholder="Texto en título, resumen o desarrollo"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="submit" className="btn btn--secondary">
          Buscar
        </button>
      </form>

      <div className="card card--table" role="tabpanel">
        {first.status === 'loading' && <Loading />}
        {first.status === 'error' && <ErrorMessage error={first.error} onRetry={first.reload} />}
        {first.status === 'ready' && items.length === 0 && (
          <Empty
            text={
              tab === 'active'
                ? 'No hay unidades activas con estos filtros.'
                : 'No hay unidades pendientes de revalidación.'
            }
          />
        )}
        {first.status === 'ready' && items.length > 0 && (
          <table className="table">
            <caption className="visually-hidden">Unidades de memoria</caption>
            <thead>
              <tr>
                <th scope="col">Tipo</th>
                <th scope="col">Título</th>
                <th scope="col">Estado</th>
                <th scope="col">Versión</th>
                <th scope="col">Origen</th>
                <th scope="col">{tab === 'active' ? 'Actualizada' : 'Revalidar desde'}</th>
                <th scope="col">
                  <span className="visually-hidden">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id}>
                  <td>
                    <TypeChip type={m.type} />
                  </td>
                  <td>
                    <p className="cell--title">{m.title}</p>
                    <p className="muted small">{m.summary}</p>
                  </td>
                  <td>
                    <StatusChip status={m.status} />
                  </td>
                  <td>v{m.version}</td>
                  <td className="mono">{formatOrigin(m.originBranch, m.originPr)}</td>
                  <td className="muted">
                    {tab === 'active' || !m.revalidateAt
                      ? formatDateTime(m.updatedAt)
                      : formatDate(m.revalidateAt)}
                  </td>
                  <td>
                    <div className="row-actions">
                      <a
                        className="btn btn--secondary btn--small"
                        href={buildHash({ name: 'memoryDetail', memoryId: m.id })}
                        aria-label={`Ver: ${m.title}`}
                      >
                        Ver
                      </a>
                      {m.status === 'active' ? (
                        <a
                          className="btn btn--secondary btn--small"
                          href={buildHash({ name: 'memoryEdit', memoryId: m.id })}
                          aria-label={`Editar: ${m.title}`}
                        >
                          Editar
                        </a>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--primary btn--small"
                          disabled={busy}
                          aria-label={`Confirmar: ${m.title}`}
                          onClick={() => confirm(m)}
                        >
                          Confirmar
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn--danger btn--small"
                        aria-label={`Retirar: ${m.title}`}
                        onClick={() => {
                          setDialogError(null);
                          setRetiring(m);
                        }}
                      >
                        Retirar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {dialogError && !retiring && !byPrOpen && !byPrStep && (
          <p className="banner banner--error" role="alert">
            {dialogError}
          </p>
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

      <RetireDialog
        open={retiring !== null}
        title={retiring ? `Retirar «${retiring.title}»` : 'Retirar unidad'}
        busy={busy}
        error={dialogError}
        onCancel={() => setRetiring(null)}
        onConfirm={(reason) => {
          const m = retiring;
          if (!m) return;
          void run(async () => {
            await api.retireMemory(projectId, m.id, { reason });
            toast('Unidad retirada');
            setRetiring(null);
          });
        }}
      />

      <ConfirmDialog
        open={byPrOpen}
        title="Retirar por PR"
        text="Retira de una vez todas las unidades activas originadas en una PR (por ejemplo, una PR revertida)."
        confirmLabel="Continuar"
        busy={false}
        error={dialogError}
        onCancel={() => setByPrOpen(false)}
        onConfirm={() => submitByPr({ preventDefault: () => undefined } as FormEvent)}
      >
        <form onSubmit={submitByPr} className="stack stack--tight">
          <label className="field__label" htmlFor={`${id}-pr`}>
            Número de PR
          </label>
          <input
            id={`${id}-pr`}
            className="input"
            inputMode="numeric"
            value={byPrPr}
            onChange={(e) => setByPrPr(e.target.value.replace(/\D/g, ''))}
          />
          <label className="field__label" htmlFor={`${id}-prreason`}>
            Motivo (obligatorio)
          </label>
          <textarea
            id={`${id}-prreason`}
            className="textarea"
            rows={3}
            maxLength={500}
            value={byPrReason}
            onChange={(e) => setByPrReason(e.target.value)}
          />
        </form>
      </ConfirmDialog>

      <ConfirmDialog
        open={byPrStep !== null}
        title="Confirmar retiro por PR"
        text={
          byPrStep
            ? `Se retirarán todas las unidades activas originadas en la PR ${byPrStep.pr}.`
            : ''
        }
        confirmLabel="Retirar unidades"
        busy={busy}
        error={dialogError}
        onCancel={() => setByPrStep(null)}
        onConfirm={() => {
          const step = byPrStep;
          if (!step) return;
          void run(async () => {
            const res = await api.retireByPr(projectId, { originPr: step.pr, reason: step.reason });
            toast(
              res.retired === 0
                ? 'No había unidades activas de esa PR'
                : res.retired === 1
                  ? 'Se retiró 1 unidad'
                  : `Se retiraron ${res.retired} unidades`,
              res.retired === 0 ? 'info' : 'success',
            );
            setByPrStep(null);
          });
        }}
      />
    </>
  );
}
