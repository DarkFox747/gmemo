/**
 * Spanish UI vocabulary. Maps are typed Record<Union, string>, so a missing
 * label is a compile error. The judge is always "Juez", never "evaluador".
 */

import type {
  ConflictCode,
  DecisionCriterion,
  MemoryStatus,
  MemoryType,
  Op,
  ProjectRole,
  QuarantineCriterion,
  QuarantineReasonCode,
  Verdict,
} from '../api/types';

const TYPE_LABELS: Record<MemoryType, string> = {
  decision: 'Decisión',
  constraint: 'Restricción',
  gotcha: 'Error resuelto',
  pattern: 'Patrón',
  integration_note: 'Nota de integración',
  domain_rule: 'Regla de dominio',
  outcome: 'Resultado',
};

const STATUS_LABELS: Record<MemoryStatus, string> = {
  active: 'Activa',
  pending_revalidation: 'Pendiente de revalidación',
  superseded: 'Reemplazada',
  deprecated: 'Retirada',
};

const ROLE_LABELS: Record<ProjectRole, string> = {
  project_admin: 'Líder técnico',
  contributor: 'Colaborador',
  viewer: 'Lector',
  service_agent: 'Agente de servicio',
};

const CRITERION_SHORT: Record<DecisionCriterion, string> = {
  specificity: 'especificidad',
  duplication: 'duplicación',
  contradiction: 'contradicción',
  grounding: 'sustento',
  confidence: 'confianza',
  security_second_layer: 'seguridad',
  stale_target: 'destino cambiado',
};

const CRITERION_LONG: Record<DecisionCriterion, string> = {
  specificity: 'Falta de especificidad',
  duplication: 'Duplica una unidad existente',
  contradiction: 'Contradicción con una unidad activa',
  grounding: 'Falta de sustento',
  confidence: 'Nivel de confianza',
  security_second_layer: 'Segunda capa de seguridad del Juez',
  stale_target: 'La unidad destino cambió',
};

/** Plain-language explanation of what the criterion means; the Juez's own text is shown separately. */
const CRITERION_EXPLANATION: Record<DecisionCriterion | QuarantineCriterion, string> = {
  specificity:
    'El Juez considera que la unidad es demasiado genérica: no indica un valor, una regla o un caso concreto que otro desarrollador pueda aplicar.',
  duplication:
    'El Juez detectó que la propuesta repite el contenido de una unidad que ya existe en la memoria.',
  contradiction:
    'El Juez detectó que la propuesta contradice una unidad activa de la memoria. Compara ambas y decide cuál debe prevalecer.',
  grounding:
    'El Juez no encontró sustento suficiente: la unidad no explica el motivo ni la evidencia que la respalda.',
  confidence:
    'El Juez no alcanzó la confianza mínima (umbral) para decidir por su cuenta; necesita la decisión de una persona.',
  security_second_layer:
    'La segunda capa de seguridad del Juez marcó contenido que podría ser sensible o contener instrucciones; revísalo con cuidado.',
  stale_target:
    'La unidad que esta propuesta modifica cambió después de ser propuesta; al aprobar se aplicará sobre la versión actual.',
  pipeline: 'La sanitización detectó contenido que no puede incorporarse tal cual a la memoria.',
  judge: 'El Juez rechazó la propuesta al evaluarla.',
  human_review: 'Un líder técnico rechazó la propuesta durante la revisión.',
};

const REASON_CODE_LABELS: Record<QuarantineReasonCode, string> = {
  secret_detected: 'Datos sensibles',
  embedded_instructions: 'Instrucciones embebidas',
  duplicate_content: 'Duplicación',
  judge_rejected: 'Rechazo del Juez',
  human_rejected: 'Rechazo del líder técnico',
  sanitize_failed: 'Fallo de sanitización',
};

const QUARANTINE_CRITERION_LABELS: Record<QuarantineCriterion, string> = {
  pipeline: 'Detectado por la sanitización',
  judge: 'Rechazado por el Juez',
  human_review: 'Rechazado por el líder técnico',
};

const OP_LABELS: Record<Op, string> = {
  add: 'Alta',
  amend: 'Modificación',
  supersede: 'Reemplazo',
  deprecate: 'Retiro',
};

const VERDICT_LABELS: Record<Verdict, string> = {
  accepted: 'Aceptada',
  rejected: 'Rechazada',
  uncertain: 'Dudosa',
};

const PROVENANCE_LABELS: Record<string, string> = {
  pr_reviewed: 'PR revisada',
  manual_ui: 'Interfaz manual',
  web_ui: 'Interfaz web',
};

export const typeLabel = (t: MemoryType): string => TYPE_LABELS[t];
export const statusLabel = (s: MemoryStatus): string => STATUS_LABELS[s];
export const criterionShort = (c: DecisionCriterion): string => CRITERION_SHORT[c];
export const criterionLong = (c: DecisionCriterion): string => CRITERION_LONG[c];
export const criterionExplanation = (c: DecisionCriterion | QuarantineCriterion): string =>
  CRITERION_EXPLANATION[c];
export const reasonCodeLabel = (r: QuarantineReasonCode): string => REASON_CODE_LABELS[r];
export const quarantineCriterionLabel = (c: QuarantineCriterion): string =>
  QUARANTINE_CRITERION_LABELS[c];
export const opLabel = (o: Op): string => OP_LABELS[o];
export const verdictLabel = (v: Verdict): string => VERDICT_LABELS[v];
export const provenanceLabel = (p: string): string => PROVENANCE_LABELS[p] ?? p;

/** /me returns the role as a plain string; anything unknown gets a neutral label. */
export function roleLabel(role: string): string {
  return Object.prototype.hasOwnProperty.call(ROLE_LABELS, role)
    ? ROLE_LABELS[role as ProjectRole]
    : 'Sin rol';
}

/** One input per allowed field key (src/mcp/fieldsPolicy.ts); `list` ↔ string[] (one per line). */
export interface FieldSpec {
  key: string;
  label: string;
  kind: 'text' | 'list';
}

export const FIELD_SPECS: Record<MemoryType, FieldSpec[]> = {
  decision: [
    { key: 'alternatives', label: 'Alternativas descartadas', kind: 'list' },
    { key: 'drivers', label: 'Factores de la decisión', kind: 'list' },
  ],
  constraint: [
    { key: 'rule', label: 'Regla', kind: 'text' },
    { key: 'scope', label: 'Alcance', kind: 'text' },
    { key: 'consequence', label: 'Consecuencia', kind: 'text' },
  ],
  gotcha: [
    { key: 'symptom', label: 'Síntoma', kind: 'text' },
    { key: 'root_cause', label: 'Causa raíz', kind: 'text' },
    { key: 'fix', label: 'Solución', kind: 'text' },
  ],
  pattern: [
    { key: 'statement', label: 'Enunciado', kind: 'text' },
    { key: 'applies_to', label: 'Se aplica a', kind: 'list' },
  ],
  integration_note: [
    { key: 'system', label: 'Sistema', kind: 'text' },
    { key: 'quirk', label: 'Particularidad', kind: 'text' },
    { key: 'workaround', label: 'Solución alternativa', kind: 'text' },
  ],
  domain_rule: [
    { key: 'rule', label: 'Regla', kind: 'text' },
    { key: 'enforced_in', label: 'Dónde se aplica', kind: 'text' },
  ],
  outcome: [
    { key: 'about', label: 'Sobre', kind: 'text' },
    { key: 'result', label: 'Resultado', kind: 'text' },
    { key: 'metrics', label: 'Métricas', kind: 'text' },
  ],
};

const CONFLICT_MESSAGES: Record<ConflictCode, string> = {
  target_changed:
    'La unidad destino cambió desde que abriste la revisión. Recarga para ver la versión actual.',
  target_inactive: 'La unidad destino ya no está activa.',
  duplicate_content: 'Ya existe una unidad con el mismo contenido. Puedes rechazar esta propuesta.',
  duplicate_inactive: 'Ya existe una unidad retirada o reemplazada con el mismo contenido.',
};

export const MESSAGES = {
  errors: {
    unauthorized:
      'No se pudo identificar al usuario. Revisa el usuario de desarrollo seleccionado.',
    not_found: 'No se encontró el elemento o no tienes acceso a él.',
    invalid: 'Los datos enviados no son válidos. Revisa el formulario.',
    rate_limited: 'Demasiadas solicitudes. Espera un momento y vuelve a intentarlo.',
    server: 'Error del servidor. Inténtalo de nuevo más tarde.',
    network: 'No hay conexión con el servidor.',
    conflict: 'La operación entra en conflicto con el estado actual. Recarga e inténtalo de nuevo.',
    unknown: 'Ocurrió un error inesperado.',
  },
  conflict: CONFLICT_MESSAGES,
  unavailable:
    'El Juez no está disponible en este momento; no se aplicó ningún cambio. Inténtalo más tarde.',
  noAccess: 'Esta sección requiere el rol de líder técnico en el proyecto seleccionado.',
  quarantineFooter:
    'Las restauraciones se registran como etiquetas para medir los falsos negativos del Juez.',
} as const;
