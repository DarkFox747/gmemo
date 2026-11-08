import { describe, expect, it } from 'vitest';
import { activityFactsText, actorText, barPercent, formatPercent, rateCountText } from './insights';

describe('formatPercent', () => {
  it('formats with a Spanish comma and at most one decimal', () => {
    expect(formatPercent(0.375)).toBe('37,5 %');
    expect(formatPercent(1 / 3)).toBe('33,3 %');
    expect(formatPercent(1)).toBe('100 %');
    expect(formatPercent(0)).toBe('0 %');
  });

  it('null rate → "sin datos"', () => {
    expect(formatPercent(null)).toBe('sin datos');
  });

  it('count text', () => {
    expect(rateCountText({ count: 3, of: 8, rate: 0.375 })).toBe('3 de 8');
  });
});

describe('barPercent', () => {
  it('is 0 for a zero max or value and caps at 100', () => {
    expect(barPercent(0, 0)).toBe(0);
    expect(barPercent(3, 0)).toBe(0);
    expect(barPercent(0, 5)).toBe(0);
    expect(barPercent(1, 4)).toBe(25);
    expect(barPercent(9, 4)).toBe(100);
  });
});

describe('activityFactsText', () => {
  it('promotion: branch, PR and the three counters', () => {
    expect(
      activityFactsText({
        branch: 'feature/login',
        prNumber: 12,
        applied: 3,
        queued: 1,
        quarantined: 1,
      }),
    ).toBe('feature/login · PR 12 · 3 aplicadas · 1 a revisión · 1 en cuarentena');
  });

  it('singular forms, outcome and empty facts', () => {
    expect(activityFactsText({ count: 1 })).toBe('1 unidad');
    expect(activityFactsText({ originPr: 7, count: 3 })).toBe('PR de origen 7 · 3 unidades');
    expect(activityFactsText({ outcome: 'queued' })).toBe('Resultado: enviada a revisión');
    expect(activityFactsText({})).toBe('—');
  });
});

describe('actorText', () => {
  it('renders each actor kind with fallbacks', () => {
    expect(actorText({ kind: 'agent', name: 'Ana' })).toBe('Agente · Ana');
    expect(actorText({ kind: 'agent', name: null })).toBe('Agente');
    expect(actorText({ kind: 'ci', name: null })).toBe('CI');
    expect(actorText({ kind: 'system', name: null })).toBe('Sistema');
    expect(actorText({ kind: 'user', name: 'Diego' })).toBe('Diego');
    expect(actorText({ kind: 'user', name: null })).toBe('Usuario sin nombre');
  });
});
