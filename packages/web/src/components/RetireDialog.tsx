import { useEffect, useId, useState } from 'react';
import { Modal } from './ConfirmDialog';

/** Retire with a required reason (3–500 characters, as the server). */
export function RetireDialog({
  open,
  title,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  busy: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    if (open) {
      setReason('');
      setFieldError(null);
    }
  }, [open]);

  function submit(): void {
    const r = reason.trim();
    if (r.length < 3 || r.length > 500) {
      setFieldError('Indica un motivo de entre 3 y 500 caracteres.');
      return;
    }
    onConfirm(r);
  }

  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <label className="field__label" htmlFor={`${id}-reason`}>
        Motivo del retiro (obligatorio)
      </label>
      <textarea
        id={`${id}-reason`}
        className="textarea"
        rows={3}
        maxLength={500}
        value={reason}
        aria-invalid={fieldError !== null}
        aria-describedby={fieldError ? `${id}-err` : undefined}
        onChange={(e) => {
          setReason(e.target.value);
          setFieldError(null);
        }}
      />
      {fieldError && (
        <p id={`${id}-err`} className="field__error">
          {fieldError}
        </p>
      )}
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog__actions">
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button type="button" className="btn btn--danger" onClick={submit} disabled={busy}>
          {busy ? 'Procesando…' : 'Retirar'}
        </button>
      </div>
    </Modal>
  );
}
