import type { MeDto } from '../api/types';
import { initials } from '../lib/format';
import { roleLabel } from '../lib/labels';
import { DEV_USERS } from '../lib/storage';

export function TopBar({
  me,
  projectId,
  role,
  devUser,
  onProjectChange,
  onDevUserChange,
}: {
  me: MeDto | null;
  projectId: string | null;
  role: string | null;
  devUser: string;
  onProjectChange: (id: string) => void;
  onDevUserChange: (email: string) => void;
}) {
  const projects = me?.projects ?? [];
  return (
    <header className="topbar">
      <div className="topbar__group">
        <label className="topbar__label" htmlFor="project-select">
          Proyecto
        </label>
        <select
          id="project-select"
          className="select select--project"
          value={projectId ?? ''}
          disabled={projects.length === 0}
          onChange={(e) => onProjectChange(e.target.value)}
        >
          {projects.length === 0 && <option value="">Sin proyectos</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="topbar__group">
        {/* Development only: the server ignores X-Dev-User in production. */}
        <label className="topbar__label topbar__label--muted" htmlFor="dev-user-select">
          Usuario de desarrollo
        </label>
        <select
          id="dev-user-select"
          className="select"
          value={devUser}
          onChange={(e) => onDevUserChange(e.target.value)}
        >
          {DEV_USERS.map((u) => (
            <option key={u.email} value={u.email}>
              {u.label} ({u.email})
            </option>
          ))}
        </select>
        <span className="topbar__role">{role ? roleLabel(role) : ''}</span>
        <span className="avatar" aria-hidden="true">
          {me ? initials(me.user.displayName, me.user.email) : '·'}
        </span>
      </div>
    </header>
  );
}
