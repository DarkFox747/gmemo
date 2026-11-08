import { useState } from 'react';
import { ApiError, errorMessage } from '../api/client';
import type { QuarantineItemDto, QuarantineReasonCode, RestoreResponseDto } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ReasonChip, TypeChip } from '../components/Chip';
import { FilterBar } from '../components/FilterBar';
import { Empty, ErrorMessage, Loading } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { formatExpiry, formatRelativeDays } from '../lib/format';
import { buildHash } from '../lib/hashRoute';
import { MESSAGES, quarantineCriterionLabel } from '../lib/labels';
import { REFRESH_MS } from '../lib/polling';
import { useAsync } from '../lib/useAsync';
import type { ScreenProps } from './types';

type FilterKey =
  'all' | 'secret_detected' | 'embedded_instructions' | 'duplicate_content' | 'human_rejected';

const FILTERS: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'Todas' },
  { key: 'secret_detected', label: 'Datos sensibles' },
  { key: 'embedded_instructions', label: 'Instrucciones embebidas' },
  { key: 'duplicate_content', label: 'Duplicación' },
  { key: 'human_rejected', label: 'Rechazo del líder técnico' },
];

/**
 * Mirrors NON_RESTORABLE_REASON_CODES (src/quarantine/reason.ts): stored
 * content is a redaction, so the server refuses the restore.
 */
const NON_RESTORABLE: ReadonlyArray<QuarantineReasonCode> = ['secret_detected', 'sanitize_failed'];

export function mayRestore(code: QuarantineReasonCode | null): boolean {
  return code !== null && !NON_RESTORABLE.includes(code);
}

export const RESTORE_TOAST: Record<RestoreResponseDto['outcome'], string> = {
  applied: 'Restaurada e incorporada a la memoria',
  queued: 'Restaurada; quedó en la cola de revisión',
  quarantined: 'El pipeline la volvió a enviar a cuarentena',
};

export const RESTORE_TEXT = 'Restaurar la unidad la vuelve a someter a sanitización y evaluación.';

export function restoreErrorMessage(err: unknown): string {
  return err instanceof ApiError && err.kind === 'not_found'
    ? 'No se puede restaurar esta unidad.'
    : errorMessage(err);
}

export function QuarantineScreen({ api, projectId, role, refreshBadges }: ScreenProps) {
  const toast = useToast();
  const isAdmin = role === 'project_admin';
  const [filter, setFilter] = useState<FilterKey>('all');
  const state = useAsync(
    () => api.listQuarantine(projectId, { reason: filter === 'all' ? undefined : filter }),
    [api, projectId, filter],
    REFRESH_MS,
  );
  const [target, setTarget] = useState<QuarantineItemDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  async function restore(): Promise<void> {
    if (!target) return;
    setBusy(true);
    setRestoreError(null);
    try {
      const res = await api.restoreQuarantineItem(projectId, target.id);
      toast(RESTORE_TOAST[res.outcome], res.outcome === 'quarantined' ? 'info' : 'success');
      setTarget(null);
      state.reload();
      refreshBadges();
    } catch (err) {
      console.error('[quarantine] restore failed', err);
      setRestoreError(restoreErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="screen__title" tabIndex={-1}>
        Cuarentena
      </h1>
      <p className="screen__subtitle">
        Unidades rechazadas por la sanitización, el Juez o el líder técnico. El contenido sensible
        se conserva redactado. Restaurar una unidad la vuelve a someter a sanitización y evaluación.
      </p>
      <FilterBar label="Filtrar por motivo" options={FILTERS} value={filter} onChange={setFilter} />
      <div className="card card--table">
        {state.status === 'loading' && <Loading />}
        {state.status === 'error' && <ErrorMessage error={state.error} onRetry={state.reload} />}
        {state.status === 'ready' && state.data.items.length === 0 && (
          <Empty text="No hay unidades en cuarentena." />
        )}
        {state.status === 'ready' && state.data.items.length > 0 && (
          <table className="table">
            <caption className="visually-hidden">Unidades en cuarentena</caption>
            <thead>
              <tr>
                <th scope="col">Motivo</th>
                <th scope="col">Unidad</th>
                <th scope="col">Extracto</th>
                <th scope="col">Ingreso</th>
                <th scope="col">Vence en</th>
                <th scope="col">
                  <span className="visually-hidden">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.data.items.map((it) => (
                <tr key={it.id}>
                  <td>
                    <ReasonChip code={it.reasonCode} />
                    {it.criterion && (
                      <p className="muted small">{quarantineCriterionLabel(it.criterion)}</p>
                    )}
                  </td>
                  <td>
                    <TypeChip type={it.type} />
                    <p className="cell--title">{it.title}</p>
                  </td>
                  <td>
                    <code className="excerpt">{it.excerpt}</code>
                  </td>
                  <td className="muted">{formatRelativeDays(it.quarantinedAt)}</td>
                  <td className="muted">{formatExpiry(it.daysUntilExpiry)}</td>
                  <td>
                    <div className="row-actions">
                      <a
                        className="btn btn--secondary btn--small"
                        href={buildHash({ name: 'quarantineDetail', id: it.id })}
                        aria-label={`Ver: ${it.title}`}
                      >
                        Ver
                      </a>
                      {isAdmin && mayRestore(it.reasonCode) && (
                        <button
                          type="button"
                          className="btn btn--primary btn--small"
                          aria-label={`Restaurar: ${it.title}`}
                          onClick={() => {
                            setRestoreError(null);
                            setTarget(it);
                          }}
                        >
                          Restaurar
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {state.status === 'ready' && state.data.truncated && (
          <p className="table__note">Se muestran las primeras 100 unidades.</p>
        )}
      </div>
      <p className="footnote">{MESSAGES.quarantineFooter}</p>
      <ConfirmDialog
        open={target !== null}
        title="Restaurar unidad"
        text={RESTORE_TEXT}
        confirmLabel="Restaurar"
        busy={busy}
        error={restoreError}
        onConfirm={restore}
        onCancel={() => setTarget(null)}
      />
    </>
  );
}
