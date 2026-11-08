import { useId, useState } from 'react';
import { ApiError, errorMessage } from '../api/client';
import type { MemoryDetailDto } from '../api/types';
import { RetireDialog } from '../components/RetireDialog';
import { RevisionDiff } from '../components/RevisionDiff';
import { StatusChip, TypeChip } from '../components/Chip';
import { FieldsView } from '../components/FieldsView';
import { ErrorMessage, Loading, NoAccess } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { formatDate, formatDateTime, formatOrigin } from '../lib/format';
import { buildHash } from '../lib/hashRoute';
import { REVISION_DIFF, opLabel, provenanceLabel } from '../lib/labels';
import { useAsync } from '../lib/useAsync';
import type { ScreenProps } from './types';

function Breadcrumb() {
  return (
    <nav aria-label="Ruta" className="breadcrumb">
      <a href={buildHash({ name: 'memory' })}>Memoria del proyecto</a>{' '}
      <span aria-hidden="true">›</span> <span>Unidad</span>
    </nav>
  );
}

export function MemoryDetailScreen(props: ScreenProps & { memoryId: string }) {
  if (props.role !== 'project_admin') {
    return (
      <>
        <Breadcrumb />
        <h1 className="screen__title" tabIndex={-1}>
          Unidad de memoria
        </h1>
        <NoAccess />
      </>
    );
  }
  return <MemoryDetail {...props} />;
}

function MemoryDetail({ api, projectId, memoryId }: ScreenProps & { memoryId: string }) {
  const state = useAsync(() => api.getMemory(projectId, memoryId), [api, projectId, memoryId]);
  if (state.status === 'loading') {
    return (
      <>
        <Breadcrumb />
        <Loading />
      </>
    );
  }
  if (state.status === 'error') {
    const gone = state.error instanceof ApiError && state.error.kind === 'not_found';
    return (
      <>
        <Breadcrumb />
        <h1 className="screen__title" tabIndex={-1}>
          Unidad de memoria
        </h1>
        {gone ? (
          <div className="state" role="alert">
            <p>No se encontró la unidad o no tienes acceso a ella.</p>
            <a className="btn btn--secondary" href={buildHash({ name: 'memory' })}>
              Volver a la memoria
            </a>
          </div>
        ) : (
          <ErrorMessage error={state.error} onRetry={state.reload} />
        )}
      </>
    );
  }
  return <Detail m={state.data} api={api} projectId={projectId} onChanged={state.reload} />;
}

function Detail({
  m,
  api,
  projectId,
  onChanged,
}: {
  m: MemoryDetailDto;
  api: ScreenProps['api'];
  projectId: string;
  onChanged: () => void;
}) {
  const toast = useToast();
  const id = useId();
  const [retireOpen, setRetireOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      console.error('[memory] action failed', err);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const canRetire = m.status === 'active' || m.status === 'pending_revalidation';

  return (
    <>
      <Breadcrumb />
      <h1 className="screen__title screen__title--detail" tabIndex={-1}>
        {m.title}
      </h1>
      <p className="meta">
        <TypeChip type={m.type} />
        <StatusChip status={m.status} />
        <span>
          Versión {m.version} · actualizada {formatDateTime(m.updatedAt).toLowerCase()}
        </span>
      </p>
      {error && !retireOpen && (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      )}
      <div className="actions actions--top">
        {m.status === 'active' && (
          <a
            className="btn btn--secondary"
            href={buildHash({ name: 'memoryEdit', memoryId: m.id })}
          >
            Editar
          </a>
        )}
        {m.status === 'pending_revalidation' && (
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api.confirmMemory(projectId, m.id);
                toast('Unidad confirmada; vuelve a estar activa');
              })
            }
          >
            {busy ? 'Procesando…' : 'Confirmar'}
          </button>
        )}
        {canRetire && (
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => {
              setError(null);
              setRetireOpen(true);
            }}
          >
            Retirar
          </button>
        )}
      </div>
      <div className="detail-grid">
        <div className="card">
          <div className="section">
            <h2 className="section__label">Resumen</h2>
            <p>{m.summary}</p>
          </div>
          <div className="section">
            <h2 className="section__label">Desarrollo</h2>
            <p className="section__box pre">{m.body}</p>
          </div>
          <FieldsView type={m.type} fields={m.fields} />
        </div>
        <div className="stack">
          <section className="card" aria-labelledby={`${id}-meta`}>
            <h2 id={`${id}-meta`} className="card__title">
              Datos
            </h2>
            <dl className="dl">
              <dt>Procedencia</dt>
              <dd>{provenanceLabel(m.provenance)}</dd>
              <dt>Autor</dt>
              <dd>{m.author ?? '—'}</dd>
              <dt>Aprobada por</dt>
              <dd>{m.approver ? (m.approver.name ?? 'Usuario sin nombre') : '—'}</dd>
              <dt>Repositorio</dt>
              <dd className="mono">{m.repo?.slug ?? '—'}</dd>
              <dt>Origen</dt>
              <dd className="mono">{formatOrigin(m.originBranch, m.originPr)}</dd>
              <dt>Revalidar desde</dt>
              <dd>{m.revalidateAt ? formatDate(m.revalidateAt) : '—'}</dd>
              {m.retiredReason && (
                <>
                  <dt>Motivo del retiro</dt>
                  <dd>{m.retiredReason}</dd>
                </>
              )}
            </dl>
          </section>
          <section className="card" aria-labelledby={`${id}-history`}>
            <h2 id={`${id}-history`} className="card__title">
              Historial de versiones
            </h2>
            <ol className="history">
              {m.revisions.map((r) => (
                <li key={r.revisionNo} className="history__item">
                  <p>
                    <strong>Versión {r.revisionNo}</strong> · {opLabel(r.op)} ·{' '}
                    {r.author ?? 'Autor sin nombre'} ·{' '}
                    <span className="muted">{formatDateTime(r.createdAt)}</span>
                  </p>
                  <details>
                    <summary>Ver contenido</summary>
                    <p className="related__title">{r.title}</p>
                    <p>{r.summary}</p>
                    <p className="section__box pre">{r.body}</p>
                    <FieldsView type={r.type} fields={r.fields} />
                  </details>
                </li>
              ))}
            </ol>
            {m.revisionsTruncated && (
              <p className="muted small">Se muestran las 100 versiones más recientes.</p>
            )}
          </section>
        </div>
      </div>
      {m.revisions.length >= 2 && (
        <section className="card revision-diff__card" aria-labelledby={`${id}-diff`}>
          <h2 id={`${id}-diff`} className="card__title">
            {REVISION_DIFF.title}
          </h2>
          {/* Remount after a reload so the default pair follows the new current version. */}
          <RevisionDiff key={m.version} revisions={m.revisions} />
        </section>
      )}
      <RetireDialog
        open={retireOpen}
        title={`Retirar «${m.title}»`}
        busy={busy}
        error={error}
        onCancel={() => setRetireOpen(false)}
        onConfirm={(reason) =>
          void act(async () => {
            await api.retireMemory(projectId, m.id, { reason });
            toast('Unidad retirada');
            setRetireOpen(false);
          })
        }
      />
    </>
  );
}
