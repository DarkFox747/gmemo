import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/**
 * Native <dialog> opened with showModal() (focus trap + Esc). Focus goes to the
 * first field on open and returns to the opener on close. Shared by
 * ConfirmDialog and RetireDialog.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      opener.current = document.activeElement;
      dlg.showModal();
      dlg.querySelector<HTMLElement>('textarea, input, select, button')?.focus();
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    const onDialogClose = (): void => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
      onClose();
    };
    dlg.addEventListener('close', onDialogClose);
    return () => dlg.removeEventListener('close', onDialogClose);
  }, [onClose]);

  return (
    <dialog ref={ref} className="dialog" aria-label={title}>
      <h2 className="dialog__title">{title}</h2>
      {children}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  text,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  text: string;
  confirmLabel: string;
  busy: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <p>{text}</p>
      {children}
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog__actions">
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button type="button" className="btn btn--primary" onClick={onConfirm} disabled={busy}>
          {busy ? 'Procesando…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
