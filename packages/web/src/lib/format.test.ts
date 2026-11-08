import { describe, expect, it } from 'vitest';
import {
  formatConfidence,
  formatDate,
  formatDateTime,
  formatExpiry,
  formatOrigin,
  formatRelativeDays,
  initials,
} from './format';

// Inputs built with the local Date constructor so the tests are TZ-independent.
const NOW = new Date(2026, 2, 12, 15, 0, 0);
const iso = (y: number, m: number, d: number, h = 0, min = 0): string =>
  new Date(y, m, d, h, min).toISOString();

describe('formatConfidence', () => {
  it('uses a decimal comma with two digits', () => {
    expect(formatConfidence(0.62)).toBe('0,62');
    expect(formatConfidence(1)).toBe('1,00');
    expect(formatConfidence(0)).toBe('0,00');
  });
  it('null → em dash', () => {
    expect(formatConfidence(null)).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('today', () => {
    expect(formatDateTime(iso(2026, 2, 12, 10, 42), NOW)).toBe('Hoy, 10:42');
  });
  it('yesterday', () => {
    expect(formatDateTime(iso(2026, 2, 11, 18, 3), NOW)).toBe('Ayer, 18:03');
  });
  it('older → dd/mm/yyyy, hh:mm', () => {
    expect(formatDateTime(iso(2026, 1, 3, 9, 15), NOW)).toBe('03/02/2026, 09:15');
  });
  it('invalid input → em dash', () => {
    expect(formatDateTime('not a date', NOW)).toBe('—');
  });
});

describe('formatDate', () => {
  it('dd/mm/yyyy', () => {
    expect(formatDate(iso(2026, 0, 5))).toBe('05/01/2026');
  });
});

describe('formatRelativeDays', () => {
  it('0, 1 and n days', () => {
    expect(formatRelativeDays(iso(2026, 2, 12, 1), NOW)).toBe('Hoy');
    expect(formatRelativeDays(iso(2026, 2, 11, 23), NOW)).toBe('Hace 1 día');
    expect(formatRelativeDays(iso(2026, 2, 7, 12), NOW)).toBe('Hace 5 días');
  });
});

describe('formatExpiry', () => {
  it('days left', () => {
    expect(formatExpiry(58)).toBe('58 días');
    expect(formatExpiry(1)).toBe('1 día');
    expect(formatExpiry(0)).toBe('Hoy');
    expect(formatExpiry(null)).toBe('—');
  });
});

describe('formatOrigin', () => {
  it('all four combinations', () => {
    expect(formatOrigin('feature/x', 184)).toBe('feature/x · PR 184');
    expect(formatOrigin('feature/x', null)).toBe('feature/x');
    expect(formatOrigin(null, 184)).toBe('PR 184');
    expect(formatOrigin(null, null)).toBe('—');
  });
});

describe('initials', () => {
  it('from the display name, ignoring parenthesised text', () => {
    expect(initials('Tech Lead (demo)', 'tl@demo.local')).toBe('TL');
    expect(initials('Ana', 'a@x')).toBe('A');
  });
  it('null name → first letter of the email, uppercase', () => {
    expect(initials(null, 'viewer@demo.local')).toBe('V');
  });
});
