/**
 * Dev user and selected project, persisted in localStorage. Storage is
 * untrusted input: the dev user must be in the allowlist, and the project id is
 * only used by the shell if it appears in /me. No tokens are ever stored.
 */

export const DEV_USERS = [
  { email: 'tl@demo.local', label: 'Líder técnico' },
  { email: 'dev@demo.local', label: 'Colaborador' },
  { email: 'viewer@demo.local', label: 'Lector' },
] as const;

const DEFAULT_DEV_USER = DEV_USERS[0].email;
const KEY_DEV_USER = 'gmemo.devUser';
const KEY_PROJECT = 'gmemo.projectId';

export interface AppStorage {
  getDevUser(): string;
  setDevUser(email: string): void;
  getProjectId(): string | null;
  setProjectId(id: string): void;
}

function isDevUser(v: string | null): v is string {
  return DEV_USERS.some((u) => u.email === v);
}

export function createStorage(s: Pick<Storage, 'getItem' | 'setItem'>): AppStorage {
  // A blocked storage throws (SecurityError): warn and fall back to defaults.
  function read(key: string): string | null {
    try {
      return s.getItem(key);
    } catch (err) {
      console.warn('[storage] localStorage no disponible; se usan valores por defecto', err);
      return null;
    }
  }
  function write(key: string, value: string): void {
    try {
      s.setItem(key, value);
    } catch (err) {
      console.warn('[storage] no se pudo guardar la preferencia', err);
    }
  }

  return {
    getDevUser() {
      const v = read(KEY_DEV_USER);
      return isDevUser(v) ? v : DEFAULT_DEV_USER;
    },
    setDevUser(email) {
      if (isDevUser(email)) write(KEY_DEV_USER, email);
    },
    getProjectId() {
      return read(KEY_PROJECT);
    },
    setProjectId(id) {
      write(KEY_PROJECT, id);
    },
  };
}
