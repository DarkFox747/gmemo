import { errorMessage } from '../api/client';
import { MESSAGES } from '../lib/labels';

export function Loading() {
  return (
    <p className="state state--loading" aria-busy="true">
      Cargando…
    </p>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="state state--empty">{text}</p>;
}

export function ErrorMessage({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state state--error" role="alert">
      <p>{errorMessage(error)}</p>
      {onRetry && (
        <button type="button" className="btn btn--secondary" onClick={onRetry}>
          Reintentar
        </button>
      )}
    </div>
  );
}

export function NoAccess() {
  return (
    <div className="state state--noaccess" role="note">
      <p className="state__title">Sin permisos</p>
      <p>{MESSAGES.noAccess}</p>
    </div>
  );
}
