import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEV_USERS, createStorage } from './storage';

function mapStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  };
}

const throwing = {
  getItem: (): string | null => {
    throw new Error('SecurityError');
  },
  setItem: (): void => {
    throw new Error('SecurityError');
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createStorage', () => {
  it('lists the three demo users', () => {
    expect(DEV_USERS.map((u) => u.email)).toEqual([
      'tl@demo.local',
      'dev@demo.local',
      'viewer@demo.local',
    ]);
  });

  it('defaults to the tech lead', () => {
    expect(createStorage(mapStorage()).getDevUser()).toBe('tl@demo.local');
  });

  it('returns a stored allowlisted user', () => {
    expect(createStorage(mapStorage({ 'gmemo.devUser': 'viewer@demo.local' })).getDevUser()).toBe(
      'viewer@demo.local',
    );
  });

  it('ignores a tampered value', () => {
    expect(createStorage(mapStorage({ 'gmemo.devUser': 'evil@x' })).getDevUser()).toBe(
      'tl@demo.local',
    );
  });

  it('setDevUser stores only allowlisted emails', () => {
    const s = mapStorage();
    const st = createStorage(s);
    st.setDevUser('evil@x');
    expect(s.map.has('gmemo.devUser')).toBe(false);
    st.setDevUser('dev@demo.local');
    expect(st.getDevUser()).toBe('dev@demo.local');
  });

  it('project id round trip; absent → null', () => {
    const st = createStorage(mapStorage());
    expect(st.getProjectId()).toBeNull();
    st.setProjectId('p-1');
    expect(st.getProjectId()).toBe('p-1');
  });

  it('a throwing storage falls back to defaults and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const st = createStorage(throwing);
    expect(st.getDevUser()).toBe('tl@demo.local');
    expect(st.getProjectId()).toBeNull();
    st.setDevUser('dev@demo.local');
    st.setProjectId('p-1');
    expect(warn).toHaveBeenCalled();
  });
});
