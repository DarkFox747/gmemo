/**
 * Hash routes. The project is app state (not in the URL), so routes stay stable
 * when the user or project changes. Ids must be UUIDs; anything else falls back
 * to the list route.
 */

import { useEffect, useState } from 'react';

export type Route =
  | { name: 'review' }
  | { name: 'reviewDetail'; itemId: string }
  | { name: 'memory' }
  | { name: 'memoryNew' }
  | { name: 'memoryDetail'; memoryId: string }
  | { name: 'memoryEdit'; memoryId: string }
  | { name: 'quarantine' }
  | { name: 'quarantineDetail'; id: string }
  | { name: 'admin' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseHash(hash: string): Route {
  const parts = hash
    .replace(/^#/, '')
    .split('/')
    .filter((p) => p.length > 0);
  const [section, id, extra] = parts;
  const validId = id !== undefined && UUID.test(id);

  switch (section) {
    case 'review':
      return validId && parts.length === 2
        ? { name: 'reviewDetail', itemId: id }
        : { name: 'review' };
    case 'memory':
      if (id === 'new' && parts.length === 2) return { name: 'memoryNew' };
      if (validId && parts.length === 2) return { name: 'memoryDetail', memoryId: id };
      if (validId && extra === 'edit' && parts.length === 3)
        return { name: 'memoryEdit', memoryId: id };
      return { name: 'memory' };
    case 'quarantine':
      return validId && parts.length === 2
        ? { name: 'quarantineDetail', id }
        : { name: 'quarantine' };
    case 'admin':
      return { name: 'admin' };
    default:
      return { name: 'review' };
  }
}

export function buildHash(r: Route): string {
  switch (r.name) {
    case 'review':
      return '#/review';
    case 'reviewDetail':
      return `#/review/${r.itemId}`;
    case 'memory':
      return '#/memory';
    case 'memoryNew':
      return '#/memory/new';
    case 'memoryDetail':
      return `#/memory/${r.memoryId}`;
    case 'memoryEdit':
      return `#/memory/${r.memoryId}/edit`;
    case 'quarantine':
      return '#/quarantine';
    case 'quarantineDetail':
      return `#/quarantine/${r.id}`;
    case 'admin':
      return '#/admin';
  }
}

export function navigate(r: Route): void {
  window.location.hash = buildHash(r);
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
