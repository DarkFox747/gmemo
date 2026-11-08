/** Pure Spanish formatters. `now` is injectable for tests; dates render in local time. */

const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n: number): string => String(n).padStart(2, '0');

function parse(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Whole calendar days between the date and now (local time). */
function daysAgo(d: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(d)) / DAY_MS);
}

export function formatConfidence(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return v.toFixed(2).replace('.', ',');
}

export function formatDate(iso: string): string {
  const d = parse(iso);
  if (!d) return '—';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function formatDateTime(iso: string, now: Date = new Date()): string {
  const d = parse(iso);
  if (!d) return '—';
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const ago = daysAgo(d, now);
  if (ago === 0) return `Hoy, ${time}`;
  if (ago === 1) return `Ayer, ${time}`;
  return `${formatDate(iso)}, ${time}`;
}

export function formatRelativeDays(iso: string, now: Date = new Date()): string {
  const d = parse(iso);
  if (!d) return '—';
  const ago = Math.max(0, daysAgo(d, now));
  if (ago === 0) return 'Hoy';
  return ago === 1 ? 'Hace 1 día' : `Hace ${ago} días`;
}

export function formatExpiry(days: number | null): string {
  if (days === null) return '—';
  if (days <= 0) return 'Hoy';
  return days === 1 ? '1 día' : `${days} días`;
}

export function formatOrigin(branch: string | null, pr: number | null): string {
  if (branch && pr !== null) return `${branch} · PR ${pr}`;
  if (branch) return branch;
  if (pr !== null) return `PR ${pr}`;
  return '—';
}

export function initials(name: string | null, email: string): string {
  const words = (name ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return (email.charAt(0) || '?').toUpperCase();
  return words
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
}
