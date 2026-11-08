import type { Route } from '../lib/hashRoute';
import { buildHash } from '../lib/hashRoute';

export interface Badges {
  review: number | null;
  quarantine: string | null;
}

type Section = 'home' | 'review' | 'staging' | 'memory' | 'quarantine' | 'activity' | 'admin';

function sectionOf(r: Route): Section {
  switch (r.name) {
    case 'home':
      return 'home';
    case 'staging':
      return 'staging';
    case 'activity':
      return 'activity';
    case 'review':
    case 'reviewDetail':
      return 'review';
    case 'memory':
    case 'memoryNew':
    case 'memoryDetail':
    case 'memoryEdit':
      return 'memory';
    case 'quarantine':
    case 'quarantineDetail':
      return 'quarantine';
    case 'admin':
      return 'admin';
  }
}

const NAV: Array<{ section: Section; label: string; route: Route }> = [
  { section: 'home', label: 'Inicio', route: { name: 'home' } },
  { section: 'review', label: 'Cola de revisión', route: { name: 'review' } },
  { section: 'staging', label: 'Área de preparación', route: { name: 'staging' } },
  { section: 'memory', label: 'Memoria del proyecto', route: { name: 'memory' } },
  { section: 'quarantine', label: 'Cuarentena', route: { name: 'quarantine' } },
  { section: 'activity', label: 'Actividad', route: { name: 'activity' } },
  { section: 'admin', label: 'Administración', route: { name: 'admin' } },
];

export function Sidebar({ route, badges }: { route: Route; badges: Badges }) {
  const current = sectionOf(route);
  return (
    <aside className="sidebar">
      <div className="brand">
        <p className="brand__name">
          crombie<span className="brand__dot">.</span> memoria
        </p>
        <p className="brand__subtitle">Memoria compartida y gobernada</p>
      </div>
      <nav aria-label="Principal">
        <ul className="nav">
          {NAV.map((n) => {
            const badge =
              n.section === 'review' && badges.review !== null && badges.review > 0
                ? {
                    text: String(badges.review),
                    cls: 'badge badge--green',
                    label: `${badges.review} pendientes`,
                  }
                : n.section === 'quarantine' &&
                    badges.quarantine !== null &&
                    badges.quarantine !== '0'
                  ? {
                      text: badges.quarantine,
                      cls: 'badge badge--red',
                      label: `${badges.quarantine} en cuarentena`,
                    }
                  : null;
            return (
              <li key={n.section}>
                <a
                  className="nav__link"
                  href={buildHash(n.route)}
                  aria-current={current === n.section ? 'page' : undefined}
                >
                  <span>{n.label}</span>
                  {badge && (
                    <span className={badge.cls} aria-label={badge.label}>
                      {badge.text}
                    </span>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <p className="sidebar__footer">Interfaz de gobierno · v1.0</p>
    </aside>
  );
}
