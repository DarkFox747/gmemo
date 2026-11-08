import { useId, useState } from 'react';
import { ApiError, errorMessage } from '../api/client';
import type { MemoryRefDto, ReviewItemDetailDto } from '../api/types';
import { Chip, StatusChip, TypeChip } from '../components/Chip';
import { ConfidenceBar } from '../components/ConfidenceBar';
import { FieldsView } from '../components/FieldsView';
import { ErrorMessage, Loading, NoAccess } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { formatDateTime } from '../lib/format';
import { buildHash } from '../lib/hashRoute';
import { criterionLong } from '../lib/labels';
import { useAsync } from '../lib/useAsync';
import type { ScreenProps } from './types';

const JUDGE_STATE: Record<ReviewItemDetailDto['judgeState'], { label: string; variant: string }> = {
  uncertain: { label: 'Dudosa', variant: 'warning' },
  accepted: { label: 'Aceptada', variant: 'active' },
  pending: { label: 'Pendiente', variant: 'neutral' },
};

export function ReviewDetailScreen(props: ScreenProps & { itemId: string }) {
  if (props.role !== 'project_admin') {
    return (
      <>
        <Breadcrumb />
        <h1 className="screen__title" tabIndex={-1}>
          Unidad propuesta
        </h1>
        <NoAccess />
      </>
    );
  }
  return <ReviewDetail {...props} />;
}

function Breadcrumb() {
  return (
    <nav aria-label="Ruta" className="breadcrumb">
      <a href={buildHash({ name: 'review' })}>Cola de revisión</a> <span aria-hidden="true">›</span>{' '}
      <span>Unidad propuesta</span>
    </nav>
  );
}

function ReviewDetail({
  api,
  projectId,
  itemId,
  refreshBadges,
  navigate,
}: ScreenProps & { itemId: string }) {
  const state = useAsync(() => api.getReviewItem(projectId, itemId), [api, projectId, itemId]);

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
          Unidad propuesta
        </h1>
        {gone ? (
          <div className="state" role="alert">
            <p>Esta unidad ya fue resuelta o no existe.</p>
            <a className="btn btn--secondary" href={buildHash({ name: 'review' })}>
              Volver a la cola
            </a>
          </div>
        ) : (
          <ErrorMessage error={state.error} onRetry={state.reload} />
        )}
      </>
    );
  }
  return (
    <ReviewForm
      key={`${state.data.id}-${state.data.target?.version ?? 0}`}
      item={state.data}
      api={api}
      projectId={projectId}
      onReload={state.reload}
      onDone={() => {
        refreshBadges();
        navigate({ name: 'review' });
      }}
    />
  );
}

function ReviewForm({
  item,
  api,
  projectId,
  onReload,
  onDone,
}: {
  item: ReviewItemDetailDto;
  api: ScreenProps['api'];
  projectId: string;
  onReload: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const id = useId();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  // Unchecked by default: superseding is an explicit reviewer choice (the server default is false too).
  const [markSuperseded, setMarkSuperseded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<{ text: string; conflict: boolean } | null>(null);

  const relatedCard: MemoryRefDto | null = item.related ?? item.target;
  const showSupersede = item.related !== null && item.op !== 'deprecate';
  const state = JUDGE_STATE[item.judgeState];

  function fail(err: unknown): void {
    console.error('[review] action failed', err);
    const conflict = err instanceof ApiError && err.kind === 'conflict';
    setActionError({ text: errorMessage(err), conflict });
  }

  async function approve(): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      const res = await api.approveReviewItem(projectId, item.id, {
        markRelatedSuperseded: showSupersede && markSuperseded,
        targetRevision: item.op !== 'add' ? item.target?.version : undefined,
      });
      toast(
        res.deduped
          ? 'Aprobada: ya existía una unidad idéntica en la memoria'
          : 'Aprobada e incorporada a la memoria',
      );
      onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function reject(): Promise<void> {
    const r = reason.trim();
    if (r.length < 3) {
      setReasonError('Indica el motivo del rechazo (al menos 3 caracteres).');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api.rejectReviewItem(projectId, item.id, { reason: r });
      toast('Rechazada y enviada a cuarentena');
      onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  function postpone(): void {
    toast('Revisión pospuesta; la unidad sigue en la cola.', 'info');
    window.location.hash = buildHash({ name: 'review' });
  }

  return (
    <>
      <Breadcrumb />
      <h1 className="screen__title screen__title--detail" tabIndex={-1}>
        {item.title}
      </h1>
      <p className="meta">
        <TypeChip type={item.type} />
        <span>
          Propuesta por {item.author} · rama <span className="mono">{item.originBranch}</span>
          {item.originPr !== null && ` · PR ${item.originPr}`} · {formatDateTime(item.createdAt)}
        </span>
      </p>

      {item.targetStale && item.target && (
        <p className="banner banner--warning" role="note">
          La unidad destino cambió (versión actual {item.target.version}). Al aprobar se aplicará
          sobre esa versión.
        </p>
      )}

      <div className="detail-grid">
        <div className="card">
          <div className="section">
            <h2 className="section__label">Resumen</h2>
            <p>{item.summary}</p>
          </div>
          <div className="section">
            <h2 className="section__label">Desarrollo</h2>
            <p className="section__box pre">{item.body}</p>
          </div>
          <FieldsView type={item.type} fields={item.fields} />

          <div className="section">
            <label className="section__label" htmlFor={`${id}-reason`}>
              Motivo de rechazo (obligatorio si se rechaza)
            </label>
            <textarea
              id={`${id}-reason`}
              className="textarea"
              rows={3}
              maxLength={500}
              value={reason}
              aria-invalid={reasonError !== null}
              aria-describedby={reasonError ? `${id}-reason-err` : undefined}
              onChange={(e) => {
                setReason(e.target.value);
                setReasonError(null);
              }}
            />
            {reasonError && (
              <p id={`${id}-reason-err`} className="field__error">
                {reasonError}
              </p>
            )}
          </div>

          {actionError && (
            <div className="banner banner--error" role="alert">
              <p>{actionError.text}</p>
              {actionError.conflict && (
                <button type="button" className="btn btn--secondary" onClick={onReload}>
                  Recargar
                </button>
              )}
            </div>
          )}

          <div className="actions">
            <button type="button" className="btn btn--primary" onClick={approve} disabled={busy}>
              {busy ? 'Procesando…' : 'Aprobar e incorporar'}
            </button>
            <button type="button" className="btn btn--danger" onClick={reject} disabled={busy}>
              Rechazar y enviar a cuarentena
            </button>
            <button type="button" className="btn btn--secondary" onClick={postpone} disabled={busy}>
              Posponer
            </button>
          </div>
        </div>

        <div className="stack">
          <section className="card" aria-labelledby={`${id}-verdict`}>
            <div className="card__head">
              <h2 id={`${id}-verdict`} className="card__title">
                Veredicto del Juez
              </h2>
              <Chip variant={state.variant}>{state.label}</Chip>
            </div>
            <div className="section">
              <h3 className="section__label">Criterio determinante</h3>
              <p>{item.criterion ? criterionLong(item.criterion) : '—'}</p>
            </div>
            <div className="section">
              <h3 className="section__label">Confianza</h3>
              <ConfidenceBar value={item.confidence} threshold={item.threshold} />
            </div>
            <div className="section">
              <h3 className="section__label">Justificación</h3>
              <p className="section__box">{item.reason ?? 'Sin justificación registrada.'}</p>
            </div>
            <div className="section">
              <h3 className="section__label">Revisión obligatoria</h3>
              <p>{item.mandatoryReview ? 'Sí (tipo de unidad de revisión obligatoria)' : 'No'}</p>
            </div>
          </section>

          <section className="card" aria-labelledby={`${id}-related`}>
            <h2 id={`${id}-related`} className="card__title">
              Unidad relacionada
            </h2>
            {relatedCard ? (
              <div className="related">
                <p className="chips">
                  <TypeChip type={relatedCard.type} />
                  <StatusChip status={relatedCard.status} />
                </p>
                <p className="related__title">{relatedCard.title}</p>
                <p className="muted">
                  Versión {relatedCard.version}
                  {relatedCard.originPr !== null && ` · origen PR ${relatedCard.originPr}`}
                </p>
              </div>
            ) : (
              <p className="muted">El Juez no identificó una unidad relacionada.</p>
            )}
            {showSupersede && (
              <div className="section">
                <h3 className="section__label">Al aprobar</h3>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={markSuperseded}
                    onChange={(e) => setMarkSuperseded(e.target.checked)}
                  />
                  <span>
                    Marcar la unidad relacionada como <strong>reemplazada</strong>
                  </span>
                </label>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
