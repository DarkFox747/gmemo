import { useId, useState } from 'react';
import { ApiError } from '../api/client';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ReasonChip, StatusChip, TypeChip } from '../components/Chip';
import { FieldsView } from '../components/FieldsView';
import { ErrorMessage, Loading } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { formatDate, formatExpiry, formatOrigin, formatRelativeDays } from '../lib/format';
import { buildHash } from '../lib/hashRoute';
import { quarantineCriterionLabel } from '../lib/labels';
import { useAsync } from '../lib/useAsync';
import { RESTORE_TEXT, RESTORE_TOAST, restoreErrorMessage } from './QuarantineScreen';
import type { ScreenProps } from './types';

function Breadcrumb() {
  return (
    <nav aria-label="Ruta" className="breadcrumb">
      <a href={buildHash({ name: 'quarantine' })}>Cuarentena</a> <span aria-hidden="true">›</span>{' '}
      <span>Unidad en cuarentena</span>
    </nav>
  );
}

export function QuarantineDetailScreen({
  api,
  projectId,
  role,
  id,
  refreshBadges,
  navigate,
}: ScreenProps & { id: string }) {
  const toast = useToast();
  const hid = useId();
  const state = useAsync(() => api.getQuarantineItem(projectId, id), [api, projectId, id]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  async function restore(): Promise<void> {
    setBusy(true);
    setRestoreError(null);
    try {
      const res = await api.restoreQuarantineItem(projectId, id);
      toast(RESTORE_TOAST[res.outcome], res.outcome === 'quarantined' ? 'info' : 'success');
      setConfirming(false);
      refreshBadges();
      navigate({ name: 'quarantine' });
    } catch (err) {
      console.error('[quarantine] restore failed', err);
      setRestoreError(restoreErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

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
          Unidad en cuarentena
        </h1>
        {gone ? (
          <div className="state" role="alert">
            <p>Esta unidad ya no está en cuarentena o no tienes acceso a ella.</p>
            <a className="btn btn--secondary" href={buildHash({ name: 'quarantine' })}>
              Volver a Cuarentena
            </a>
          </div>
        ) : (
          <ErrorMessage error={state.error} onRetry={state.reload} />
        )}
      </>
    );
  }

  const q = state.data;
  const canRestore = q.canRestore && role === 'project_admin';
  return (
    <>
      <Breadcrumb />
      <h1 className="screen__title screen__title--detail" tabIndex={-1}>
        {q.title}
      </h1>
      <p className="meta">
        <ReasonChip code={q.reasonCode} />
        <TypeChip type={q.type} />
        <span>
          Propuesta por {q.author} · origen{' '}
          <span className="mono">{formatOrigin(q.originBranch, q.originPr)}</span> · ingresó{' '}
          {formatRelativeDays(q.quarantinedAt).toLowerCase()}
        </span>
      </p>
      <div className="detail-grid">
        <div className="card">
          <div className="section">
            <h2 className="section__label">Resumen</h2>
            <p>{q.summary}</p>
          </div>
          <div className="section">
            <h2 className="section__label">Desarrollo (redactado)</h2>
            <p className="section__box pre mono">{q.body}</p>
          </div>
          <FieldsView type={q.type} fields={q.fields} />
          {canRestore && (
            <div className="actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setRestoreError(null);
                  setConfirming(true);
                }}
              >
                Restaurar
              </button>
            </div>
          )}
        </div>
        <div className="stack">
          <section className="card" aria-labelledby={`${hid}-why`}>
            <h2 id={`${hid}-why`} className="card__title">
              Motivo de la cuarentena
            </h2>
            <div className="section">
              <h3 className="section__label">Criterio</h3>
              <p>{q.criterion ? quarantineCriterionLabel(q.criterion) : '—'}</p>
            </div>
            {q.judgeReason !== undefined && (
              <div className="section">
                <h3 className="section__label">Justificación registrada</h3>
                <p className="section__box">{q.judgeReason}</p>
              </div>
            )}
            <div className="section">
              <h3 className="section__label">Vence</h3>
              <p>
                {q.expiresAt
                  ? `${formatDate(q.expiresAt)} (en ${formatExpiry(q.daysUntilExpiry)})`
                  : 'Sin vencimiento'}
              </p>
            </div>
            {!q.canRestore && (
              <p className="muted">
                Esta unidad no se puede restaurar: su contenido se conserva redactado.
              </p>
            )}
          </section>
          {q.related && (
            <section className="card" aria-labelledby={`${hid}-related`}>
              <h2 id={`${hid}-related`} className="card__title">
                Unidad relacionada
              </h2>
              <div className="related">
                <p className="chips">
                  <TypeChip type={q.related.type} />
                  <StatusChip status={q.related.status} />
                </p>
                <p className="related__title">{q.related.title}</p>
                <p className="muted">Versión {q.related.version}</p>
              </div>
            </section>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Restaurar unidad"
        text={RESTORE_TEXT}
        confirmLabel="Restaurar"
        busy={busy}
        error={restoreError}
        onConfirm={restore}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
