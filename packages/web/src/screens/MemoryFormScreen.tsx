import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, errorMessage } from '../api/client';
import { MEMORY_TYPES } from '../api/types';
import type { MemoryDetailDto, MemoryType, PreviewResponseDto, UnitRequest } from '../api/types';
import { Chip, StatusChip, TypeChip } from '../components/Chip';
import { ConfidenceBar } from '../components/ConfidenceBar';
import { FieldsEditor, draftToFields, fieldsToDraft } from '../components/FieldsEditor';
import type { FieldDraft } from '../components/FieldsEditor';
import { FieldsView } from '../components/FieldsView';
import { ErrorMessage, Loading, NoAccess } from '../components/StateViews';
import { useToast } from '../components/Toast';
import { buildHash } from '../lib/hashRoute';
import { criterionLong, reasonCodeLabel, typeLabel, verdictLabel } from '../lib/labels';
import { useAsync } from '../lib/useAsync';
import type { ScreenProps } from './types';

const LIMITS = { title: 120, summary: 200, body: 2000 } as const;

const WITHOUT_APPROVAL: Record<PreviewResponseDto['withoutApproval'], string> = {
  apply: 'se incorporaría automáticamente',
  queue_uncertain: 'iría a la cola de revisión como dudosa',
  queue_mandatory: 'iría a la cola de revisión obligatoria',
  quarantine: 'iría a cuarentena',
};

interface Draft {
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  fields: FieldDraft;
}

function Breadcrumb({ edit }: { edit: boolean }) {
  return (
    <nav aria-label="Ruta" className="breadcrumb">
      <a href={buildHash({ name: 'memory' })}>Memoria del proyecto</a>{' '}
      <span aria-hidden="true">›</span> <span>{edit ? 'Editar unidad' : 'Nueva unidad'}</span>
    </nav>
  );
}

export function MemoryFormScreen(props: ScreenProps & { memoryId?: string }) {
  const edit = props.memoryId !== undefined;
  if (props.role !== 'project_admin') {
    return (
      <>
        <Breadcrumb edit={edit} />
        <h1 className="screen__title" tabIndex={-1}>
          {edit ? 'Editar unidad' : 'Nueva unidad'}
        </h1>
        <NoAccess />
      </>
    );
  }
  return props.memoryId ? (
    <EditLoader {...props} memoryId={props.memoryId} />
  ) : (
    <MemoryForm {...props} existing={null} />
  );
}

function EditLoader(props: ScreenProps & { memoryId: string }) {
  const { api, projectId, memoryId } = props;
  const state = useAsync(() => api.getMemory(projectId, memoryId), [api, projectId, memoryId]);
  if (state.status === 'loading') {
    return (
      <>
        <Breadcrumb edit />
        <Loading />
      </>
    );
  }
  if (state.status === 'error') {
    return (
      <>
        <Breadcrumb edit />
        <h1 className="screen__title" tabIndex={-1}>
          Editar unidad
        </h1>
        <ErrorMessage error={state.error} onRetry={state.reload} />
      </>
    );
  }
  return <MemoryForm {...props} existing={state.data} />;
}

function toUnit(d: Draft): UnitRequest {
  return {
    type: d.type,
    title: d.title.trim(),
    summary: d.summary.trim(),
    body: d.body.trim(),
    fields: draftToFields(d.type, d.fields),
  };
}

function MemoryForm({
  api,
  projectId,
  navigate,
  existing,
}: ScreenProps & { existing: MemoryDetailDto | null }) {
  const toast = useToast();
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() =>
    existing
      ? {
          type: existing.type,
          title: existing.title,
          summary: existing.summary,
          body: existing.body,
          fields: fieldsToDraft(existing.type, existing.fields),
        }
      : { type: 'gotcha', title: '', summary: '', body: '', fields: {} },
  );
  const [revision, setRevision] = useState(existing?.version ?? 0);
  const [preview, setPreview] = useState<{ dto: PreviewResponseDto; unit: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<{ text: string; reload: boolean } | null>(null);

  const unit = toUnit(draft);
  const unitKey = JSON.stringify(unit);
  // Confirm is only possible for exactly the content that was previewed.
  const previewIsCurrent = preview !== null && preview.unit === unitKey;
  const canConfirm = previewIsCurrent && preview.dto.outcome !== 'unavailable';

  function update(patch: Partial<Draft>): void {
    setDraft((d) => ({ ...d, ...patch }));
    setPreview(null);
  }

  function validate(): string | null {
    if (!unit.title || !unit.summary || !unit.body)
      return 'Completa el título, el resumen y el desarrollo.';
    if (
      unit.title.length > LIMITS.title ||
      unit.summary.length > LIMITS.summary ||
      unit.body.length > LIMITS.body
    ) {
      return 'Algún texto supera la longitud máxima.';
    }
    return null;
  }

  function fail(err: unknown): void {
    console.error('[memory] form action failed', err);
    const stale =
      err instanceof ApiError && err.kind === 'conflict' && err.conflictCode === 'target_changed';
    setFormError({ text: errorMessage(err), reload: stale });
  }

  async function runPreview(e: FormEvent): Promise<void> {
    e.preventDefault();
    const invalid = validate();
    if (invalid) {
      setFormError({ text: invalid, reload: false });
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const dto = await api.previewMemory(
        projectId,
        existing
          ? { op: 'amend', ...unit, targetMemoryId: existing.id, expectedRevision: revision }
          : { op: 'add', ...unit },
      );
      setPreview({ dto, unit: unitKey });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    setBusy(true);
    setFormError(null);
    try {
      const res = existing
        ? await api.amendMemory(projectId, existing.id, { ...unit, expectedRevision: revision })
        : await api.createMemory(projectId, unit);
      if (res.outcome === 'applied') {
        toast(
          res.deduped
            ? 'Ya existía una unidad idéntica; no se creó otra'
            : 'Unidad guardada en la memoria',
        );
        navigate({ name: 'memoryDetail', memoryId: res.memory.id });
      } else {
        toast('La unidad fue enviada a cuarentena', 'info');
        navigate({ name: 'quarantine' });
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  /** Re-fetch the current version and keep the user's draft. */
  async function reloadTarget(): Promise<void> {
    if (!existing) return;
    setBusy(true);
    try {
      const fresh = await api.getMemory(projectId, existing.id);
      setRevision(fresh.version);
      setPreview(null);
      setFormError({
        text: `Se cargó la versión ${fresh.version}. Revisa tus cambios y vuelve a previsualizar.`,
        reload: false,
      });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  const title = existing ? 'Editar unidad' : 'Nueva unidad';
  return (
    <>
      <Breadcrumb edit={existing !== null} />
      <h1 className="screen__title" tabIndex={-1}>
        {title}
      </h1>
      <p className="screen__subtitle">
        Antes de guardar, la unidad pasa por la sanitización y el Juez. Previsualiza el veredicto y
        luego confirma.
      </p>
      <div className="detail-grid">
        <form className="card" onSubmit={runPreview} noValidate>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-type`}>
              Tipo
            </label>
            <select
              id={`${id}-type`}
              className="select"
              value={draft.type}
              disabled={existing !== null}
              onChange={(e) => update({ type: e.target.value as MemoryType, fields: {} })}
            >
              {MEMORY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {typeLabel(t)}
                </option>
              ))}
            </select>
          </div>
          <TextField
            id={`${id}-title`}
            label="Título"
            value={draft.title}
            max={LIMITS.title}
            onChange={(v) => update({ title: v })}
          />
          <TextField
            id={`${id}-summary`}
            label="Resumen"
            value={draft.summary}
            max={LIMITS.summary}
            multiline
            onChange={(v) => update({ summary: v })}
          />
          <TextField
            id={`${id}-body`}
            label="Desarrollo"
            value={draft.body}
            max={LIMITS.body}
            multiline
            rows={6}
            onChange={(v) => update({ body: v })}
          />
          <FieldsEditor
            type={draft.type}
            draft={draft.fields}
            onChange={(f) => update({ fields: f })}
          />
          {formError && (
            <div className="banner banner--error" role="alert">
              <p>{formError.text}</p>
              {formError.reload && (
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={reloadTarget}
                  disabled={busy}
                >
                  Recargar
                </button>
              )}
            </div>
          )}
          <div className="actions">
            <button type="submit" className="btn btn--secondary" disabled={busy}>
              {busy && !previewIsCurrent ? 'Procesando…' : 'Previsualizar'}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={confirm}
              disabled={busy || !canConfirm}
            >
              {busy && previewIsCurrent ? 'Procesando…' : 'Confirmar'}
            </button>
            <a
              className="btn btn--secondary"
              href={buildHash(
                existing ? { name: 'memoryDetail', memoryId: existing.id } : { name: 'memory' },
              )}
            >
              Cancelar
            </a>
          </div>
        </form>
        <div className="stack">
          {previewIsCurrent ? (
            <PreviewPanel dto={preview.dto} type={draft.type} />
          ) : (
            <section className="card">
              <h2 className="card__title">Previsualización</h2>
              <p className="muted">
                Aún no hay previsualización para este contenido. Usa «Previsualizar» para ver el
                veredicto del Juez.
              </p>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function TextField({
  id,
  label,
  value,
  max,
  multiline,
  rows,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  max: number;
  multiline?: boolean;
  rows?: number;
  onChange: (v: string) => void;
}) {
  const over = value.length > max;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          className="textarea"
          rows={rows ?? 2}
          value={value}
          aria-invalid={over}
          aria-describedby={`${id}-count`}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          className="input"
          value={value}
          aria-invalid={over}
          aria-describedby={`${id}-count`}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <p id={`${id}-count`} className={over ? 'field__count field__count--over' : 'field__count'}>
        {value.length}/{max}
      </p>
    </div>
  );
}

function PreviewPanel({ dto, type }: { dto: PreviewResponseDto; type: MemoryType }) {
  const findings = [
    ...(dto.pipeline.findings.secrets ?? []).map((c) => `Secreto: ${c}`),
    ...(dto.pipeline.findings.injection ?? []).map((c) => `Instrucción: ${c}`),
    ...(dto.pipeline.findings.pii ?? []).map((c) => `Dato personal: ${c}`),
  ];
  const banner =
    dto.outcome === 'apply'
      ? { cls: 'banner banner--success', text: 'Se incorporará a la memoria al confirmar.' }
      : dto.outcome === 'quarantine'
        ? {
            cls: 'banner banner--warning',
            text: `Irá a cuarentena (${dto.quarantineReasonCode ? reasonCodeLabel(dto.quarantineReasonCode) : 'sin clasificar'}).`,
          }
        : {
            cls: 'banner banner--error',
            text: 'El Juez no está disponible; no se puede confirmar ahora. Inténtalo más tarde.',
          };
  return (
    <>
      <section className="card" aria-label="Resultado de la previsualización">
        <h2 className="card__title">Previsualización</h2>
        <p className={banner.cls}>{banner.text}</p>
        <p className="muted small">
          Si la propusiera un agente, {WITHOUT_APPROVAL[dto.withoutApproval]}.
        </p>
        {findings.length > 0 && (
          <p className="chips">
            {findings.map((f) => (
              <Chip key={f} variant="reason">
                {f}
              </Chip>
            ))}
          </p>
        )}
      </section>
      {dto.judge && (
        <section className="card" aria-label="Veredicto del Juez">
          <div className="card__head">
            <h2 className="card__title">Veredicto del Juez</h2>
            <Chip
              variant={
                dto.judge.verdict === 'accepted'
                  ? 'active'
                  : dto.judge.verdict === 'uncertain'
                    ? 'warning'
                    : 'reason'
              }
            >
              {verdictLabel(dto.judge.verdict)}
            </Chip>
          </div>
          <div className="section">
            <h3 className="section__label">Criterio determinante</h3>
            <p>{criterionLong(dto.judge.criterion)}</p>
          </div>
          <div className="section">
            <h3 className="section__label">Confianza</h3>
            <ConfidenceBar value={dto.judge.confidence} threshold={dto.judge.threshold} />
          </div>
          <div className="section">
            <h3 className="section__label">Justificación</h3>
            <p className="section__box">{dto.judge.reason}</p>
          </div>
          {dto.judge.related && (
            <div className="section">
              <h3 className="section__label">Unidad relacionada</h3>
              <p className="chips">
                <TypeChip type={dto.judge.related.type} />
                <StatusChip status={dto.judge.related.status} />
              </p>
              <p className="related__title">{dto.judge.related.title}</p>
            </div>
          )}
        </section>
      )}
      {dto.preview && (
        <section className="card" aria-label="Contenido tal como se guardará">
          <h2 className="card__title">Contenido tal como se guardará</h2>
          <p className="related__title">{dto.preview.title}</p>
          <p>{dto.preview.summary}</p>
          <p className="section__box pre">{dto.preview.body}</p>
          <FieldsView type={type} fields={dto.preview.fields} />
        </section>
      )}
    </>
  );
}
