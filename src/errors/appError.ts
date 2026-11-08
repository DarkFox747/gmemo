// Error codes for all domain-level failures in the facade.
// Each code maps to a generic, non-enumerating message (contract §6 + OWASP).
// Never expose tenant names, resource IDs, stack traces, or internal state.

export enum ErrorCode {
  /** Remote not registered, or project/repo not found. */
  CONTEXT_UNAVAILABLE = 'CONTEXT_UNAVAILABLE',
  /** Actor lacks sufficient permission; never reveals whether resource exists. */
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  /** Handle is invalid or expired; agent must recall again to get a fresh handle. */
  INVALID_REFERENCE = 'INVALID_REFERENCE',
  /** Catch-all for unexpected errors. No internal detail is surfaced. */
  INTERNAL = 'INTERNAL',
  /** REST: missing or invalid credentials (Gate 1 failure on /api). */
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  /** REST: resource absent (or not visible to the caller). */
  NOT_FOUND = 'NOT_FOUND',
  /** REST: request failed input validation. */
  INVALID_REQUEST = 'INVALID_REQUEST',
}

// Generic, client-safe messages — no resource names, no tenant info, no hints.
const OPAQUE_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.CONTEXT_UNAVAILABLE]: 'Memory is not available in this context.',
  [ErrorCode.PERMISSION_DENIED]: 'Access denied.',
  [ErrorCode.INVALID_REFERENCE]: 'Invalid or expired reference; please recall again.',
  [ErrorCode.INTERNAL]: 'An internal error occurred.',
  [ErrorCode.UNAUTHENTICATED]: 'Unauthorized.',
  [ErrorCode.NOT_FOUND]: 'Not found.',
  [ErrorCode.INVALID_REQUEST]: 'Invalid request.',
};

/**
 * Structured application error that carries a typed code and a pre-composed
 * opaque message safe to return verbatim to agents. Internal cause (if any)
 * is stored on `this.cause` for server-side logging only.
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly opaqueMessage: string;

  constructor(code: ErrorCode, cause?: unknown) {
    const opaqueMessage = OPAQUE_MESSAGES[code];
    super(opaqueMessage);
    this.name = 'AppError';
    this.code = code;
    this.opaqueMessage = opaqueMessage;
    if (cause != null) {
      this.cause = cause;
    }
  }
}
