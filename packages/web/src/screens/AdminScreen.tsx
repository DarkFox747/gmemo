import { useId } from 'react';
import type { AdminSummaryDto } from '../api/types';
import { Chip } from '../components/Chip';
import { Empty, ErrorMessage, Loading, NoAccess } from '../components/StateViews';
import { formatDate } from '../lib/format';
import { roleLabel } from '../lib/labels';
import { useAsync } from '../lib/useAsync';
import type { ScreenProps } from './types';

const CREDENTIAL_STATUS: Record<
  AdminSummaryDto['credentials'][number]['status'],
  { label: string; variant: string }
> = {
  active: { label: 'Activa', variant: 'active' },
  expired: { label: 'Vencida', variant: 'warning' },
  revoked: { label: 'Revocada', variant: 'neutral' },
};

function Header() {
  return (
    <>
      <h1 className="screen__title" tabIndex={-1}>
        Administración del proyecto
      </h1>
      <p className="screen__subtitle">
        Proyecto, repositorios, miembros y credenciales de servicio. Vista de solo lectura: las
        altas y bajas se gestionan por ticket.
      </p>
    </>
  );
}

export function AdminScreen(props: ScreenProps) {
  if (props.role !== 'project_admin') {
    return (
      <>
        <Header />
        <NoAccess />
      </>
    );
  }
  return <Admin {...props} />;
}

function Admin({ api, projectId }: ScreenProps) {
  const id = useId();
  const state = useAsync(() => api.getAdminSummary(projectId), [api, projectId]);
  if (state.status === 'loading') {
    return (
      <>
        <Header />
        <Loading />
      </>
    );
  }
  if (state.status === 'error') {
    return (
      <>
        <Header />
        <ErrorMessage error={state.error} onRetry={state.reload} />
      </>
    );
  }
  const s = state.data;
  return (
    <>
      <Header />
      <div className="admin-grid">
        <div className="stack">
          <section className="card" aria-labelledby={`${id}-project`}>
            <h2 id={`${id}-project`} className="card__title">
              Datos del proyecto
            </h2>
            <div className="section">
              <h3 className="section__label">Nombre</h3>
              <p className="section__box">{s.project.name}</p>
            </div>
            <div className="section">
              <h3 className="section__label">Identificador</h3>
              <p className="section__box mono">{s.project.slug}</p>
            </div>
            <div className="section">
              <h3 className="section__label">Alta</h3>
              <p className="section__box">{formatDate(s.project.createdAt)}</p>
            </div>
          </section>
          <section className="card" aria-labelledby={`${id}-repos`}>
            <h2 id={`${id}-repos`} className="card__title">
              Repositorios
            </h2>
            {s.repos.length === 0 && <Empty text="El proyecto no tiene repositorios." />}
            {s.repos.map((r) => (
              <div key={r.id} className="section__box repo">
                {/* Shown as text, never as a link: URLs from data are not put in href. */}
                <p className="mono">{r.remoteUrl}</p>
                <p className="muted small">
                  Rama de promoción: <span className="mono">{r.defaultBranch}</span>
                </p>
              </div>
            ))}
          </section>
        </div>
        <div className="stack">
          <section className="card" aria-labelledby={`${id}-members`}>
            <h2 id={`${id}-members`} className="card__title">
              Miembros y roles
            </h2>
            <table className="table">
              <caption className="visually-hidden">Miembros del proyecto</caption>
              <thead>
                <tr>
                  <th scope="col">Miembro</th>
                  <th scope="col">Rol</th>
                  <th scope="col">Alta</th>
                </tr>
              </thead>
              <tbody>
                {s.members.map((m) => (
                  <tr key={m.userId}>
                    <td>
                      <p className="cell--title">{m.displayName ?? m.email}</p>
                      <p className="muted small">{m.email}</p>
                    </td>
                    <td>
                      {roleLabel(m.role)}
                      {m.disabled && (
                        <>
                          {' '}
                          <Chip variant="neutral">Deshabilitado</Chip>
                        </>
                      )}
                    </td>
                    <td className="muted">{formatDate(m.grantedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="card" aria-labelledby={`${id}-creds`}>
            <h2 id={`${id}-creds`} className="card__title">
              Credenciales de servicio
            </h2>
            {s.credentials.length === 0 ? (
              <Empty text="El proyecto no tiene credenciales de servicio." />
            ) : (
              <table className="table">
                <caption className="visually-hidden">Credenciales de servicio</caption>
                <thead>
                  <tr>
                    <th scope="col">Credencial</th>
                    <th scope="col">Rol</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Vence</th>
                  </tr>
                </thead>
                <tbody>
                  {s.credentials.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <p className="cell--title mono">{c.principalName}</p>
                        <p className="muted small">credencial de servicio</p>
                      </td>
                      <td>{roleLabel(c.role)}</td>
                      <td>
                        <Chip variant={CREDENTIAL_STATUS[c.status].variant}>
                          {CREDENTIAL_STATUS[c.status].label}
                        </Chip>
                      </td>
                      <td className="muted">{formatDate(c.expiresAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
