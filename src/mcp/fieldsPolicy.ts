// Per-type fields validation for the remember tool.
//
// Design: Decision 5 (write-path design.md).
// Policy: strict on shape, lenient on presence.
//   - Any key present that is NOT in the allowed set for the type → INVALID_REFERENCE.
//   - Absent or empty fields object → accepted without error.
//   - Values are not deep-typed (contract §1 calls fields "skill-guided").
//
// The allowed-key map is derived from contract §1 / docs/05-tipos-memoria-y-busqueda.md.

import type { MemoryType } from '../contracts/memory.js';
import { AppError, ErrorCode } from '../errors/appError.js';

/**
 * Exhaustive allowed-key map keyed by MemoryType.
 * TypeScript enforces that every MemoryType variant is present at compile time.
 */
const ALLOWED_FIELDS: Record<MemoryType, ReadonlySet<string>> = {
  decision: new Set(['alternatives', 'drivers']),
  constraint: new Set(['rule', 'scope', 'consequence']),
  gotcha: new Set(['symptom', 'root_cause', 'fix']),
  pattern: new Set(['statement', 'applies_to']),
  integration_note: new Set(['system', 'quirk', 'workaround']),
  domain_rule: new Set(['rule', 'enforced_in']),
  outcome: new Set(['about', 'result', 'metrics']),
};

/**
 * Validates that every key in `fields` is an allowed field for the given
 * memory `type`. Empty or absent `fields` passes without error.
 *
 * Does NOT validate value types — the contract treats field values as
 * untyped and skill-guided.
 *
 * @throws {AppError} with code `INVALID_REFERENCE` on the first unknown key.
 *         The error message is opaque (does not reveal the key name) to avoid
 *         leaking schema information to the caller.
 */
export function assertValidFields(
  type: MemoryType,
  fields: Record<string, unknown>,
): void {
  const allowed = ALLOWED_FIELDS[type];
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) {
      throw new AppError(ErrorCode.INVALID_REFERENCE);
    }
  }
}
