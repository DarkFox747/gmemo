/** Pure helpers of the governance insight screens (Inicio, Actividad, Área de preparación). */

import type { ActivityEventDto, ActivityFactsDto, RateDto } from '../api/types';
import { METRICS, outcomeLabel } from './labels';

/** 0.375 → "37,5 %"; null → "sin datos". One decimal at most, Spanish comma. */
export function formatPercent(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return METRICS.noData;
  const pct = Math.round(rate * 1000) / 10;
  return `${String(pct).replace('.', ',')} %`;
}

/** "3 de 8". */
export function rateCountText(r: RateDto): string {
  return `${r.count} de ${r.of}`;
}

/** Width (0–100) of a decorative bar; a zero or negative max gives 0. */
export function barPercent(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(100, Math.round((value / max) * 100));
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Short detail of an activity event built from its allow-listed facts, in a fixed order. */
export function activityFactsText(f: ActivityFactsDto): string {
  const parts: string[] = [];
  if (f.branch !== undefined) parts.push(f.branch);
  if (f.prNumber !== undefined) parts.push(`PR ${f.prNumber}`);
  if (f.applied !== undefined) parts.push(plural(f.applied, 'aplicada', 'aplicadas'));
  if (f.queued !== undefined) parts.push(`${f.queued} a revisión`);
  if (f.quarantined !== undefined) parts.push(`${f.quarantined} en cuarentena`);
  if (f.discarded !== undefined) parts.push(plural(f.discarded, 'descartada', 'descartadas'));
  if (f.originPr !== undefined) parts.push(`PR de origen ${f.originPr}`);
  if (f.count !== undefined) parts.push(plural(f.count, 'unidad', 'unidades'));
  if (f.outcome !== undefined) parts.push(`Resultado: ${outcomeLabel(f.outcome)}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** "Agente" / "Agente · Ana", "CI", "Sistema", or the user's display name. */
export function actorText(actor: ActivityEventDto['actor']): string {
  switch (actor.kind) {
    case 'agent':
      return actor.name ? `Agente · ${actor.name}` : 'Agente';
    case 'ci':
      return 'CI';
    case 'system':
      return 'Sistema';
    case 'user':
      return actor.name ?? 'Usuario sin nombre';
  }
}
