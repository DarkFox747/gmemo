import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_ACTIONS,
  ACTIVITY_CATEGORIES,
  CONFLICT_CODES,
  JUDGE_STATES,
  SESSION_STATUSES,
  STAGING_ITEM_STATES,
  DECISION_CRITERIA,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  OPS,
  PROJECT_ROLES,
  QUARANTINE_CRITERIA,
  QUARANTINE_REASON_CODES,
  VERDICTS,
} from '../api/types';
import * as labels from './labels';

describe('labels', () => {
  it('every union value has a non-empty Spanish label', () => {
    for (const t of MEMORY_TYPES) expect(labels.typeLabel(t)).not.toBe('');
    for (const s of MEMORY_STATUSES) expect(labels.statusLabel(s)).not.toBe('');
    for (const r of PROJECT_ROLES) expect(labels.roleLabel(r)).not.toBe('');
    for (const c of DECISION_CRITERIA) {
      expect(labels.criterionShort(c)).not.toBe('');
      expect(labels.criterionLong(c)).not.toBe('');
      expect(labels.criterionExplanation(c)).not.toBe('');
    }
    for (const r of QUARANTINE_REASON_CODES) expect(labels.reasonCodeLabel(r)).not.toBe('');
    for (const c of QUARANTINE_CRITERIA) {
      expect(labels.quarantineCriterionLabel(c)).not.toBe('');
      expect(labels.criterionExplanation(c)).not.toBe('');
    }
    for (const o of OPS) expect(labels.opLabel(o)).not.toBe('');
    for (const v of VERDICTS) expect(labels.verdictLabel(v)).not.toBe('');
    for (const c of CONFLICT_CODES) expect(labels.MESSAGES.conflict[c]).not.toBe('');
    for (const a of ACTIVITY_ACTIONS) expect(labels.activityActionLabel(a)).not.toBe('');
    for (const c of ACTIVITY_CATEGORIES) expect(labels.activityCategoryLabel(c)).not.toBe('');
    for (const s of STAGING_ITEM_STATES) expect(labels.stagingItemStateLabel(s)).not.toBe('');
    for (const s of SESSION_STATUSES) expect(labels.sessionStatusLabel(s)).not.toBe('');
    for (const s of JUDGE_STATES) expect(labels.judgeStateLabel(s)).not.toBe('');
  });

  it('quarantine footer measures false positives, consistent with Inicio', () => {
    expect(labels.MESSAGES.quarantineFooter).toContain('falsos positivos del Juez');
    expect(labels.MESSAGES.quarantineFooter).not.toContain('falsos negativos');
    expect(labels.METRICS.falsePositiveDefinition).toContain('restaurada');
    expect(labels.METRICS.falseNegativeDefinition).toContain('rechazada en revisión');
  });

  it('unknown role strings get a neutral label', () => {
    expect(labels.roleLabel('something_else')).toBe('Sin rol');
  });

  it('FIELD_SPECS keys equal the server allow-list per type', () => {
    // Literal copy of ALLOWED_FIELDS in src/mcp/fieldsPolicy.ts.
    const allowed: Record<string, string[]> = {
      decision: ['alternatives', 'drivers'],
      constraint: ['rule', 'scope', 'consequence'],
      gotcha: ['symptom', 'root_cause', 'fix'],
      pattern: ['statement', 'applies_to'],
      integration_note: ['system', 'quirk', 'workaround'],
      domain_rule: ['rule', 'enforced_in'],
      outcome: ['about', 'result', 'metrics'],
    };
    for (const t of MEMORY_TYPES) {
      expect(labels.FIELD_SPECS[t].map((f) => f.key)).toEqual(allowed[t]);
    }
  });

  it('never says "evaluador"; judge strings say "Juez"', () => {
    const all = JSON.stringify(labels);
    const values = [
      all,
      ...DECISION_CRITERIA.map((c) => labels.criterionLong(c)),
      ...QUARANTINE_CRITERIA.map((c) => labels.quarantineCriterionLabel(c)),
    ].join(' ');
    expect(values.toLowerCase()).not.toContain('evaluador');
    expect(labels.quarantineCriterionLabel('judge')).toContain('Juez');
    expect(labels.MESSAGES.unavailable).toContain('Juez');
    expect(labels.MESSAGES.quarantineFooter).toContain('Juez');
  });
});
