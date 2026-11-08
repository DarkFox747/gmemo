/**
 * REST error mapper — the whole /api error vocabulary in one place.
 *
 * Mounted at app level as `app.use('/api', apiErrorHandler)` (after the API
 * router, before the terminal handler) so express.json parse errors on /api
 * paths, which are raised before the router runs, are mapped too.
 *
 * | Thrown                                                        | Status | Body                               |
 * |---------------------------------------------------------------|--------|------------------------------------|
 * | AppError(UNAUTHENTICATED)                                     | 401    | {"error":"Unauthorized"}           |
 * | AppError(PERMISSION_DENIED|NOT_FOUND|CONTEXT_UNAVAILABLE|INVALID_REFERENCE) | 404 | {"error":"Not found"} |
 * | AppError(INVALID_REQUEST) or a 4xx body-parser error          | 400    | {"error":"Invalid request"}        |
 * | anything else                                                 | 500    | {"error":"Internal server error"}  |
 *
 * 409 and 503 are not produced here: the routes write them directly (expected
 * outcomes — e.g. 503 evaluation_unavailable on a direct memory confirm).
 * Client errors are logged at debug with the code only (never input or cause).
 */

import type { ErrorRequestHandler, Response } from 'express';
import { AppError, ErrorCode } from '../../errors/appError.js';
import { logger } from '../../observability/logger.js';
import type { ApiErrorBody } from './types.js';

const NOT_FOUND_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCode.PERMISSION_DENIED,
  ErrorCode.NOT_FOUND,
  ErrorCode.CONTEXT_UNAVAILABLE,
  ErrorCode.INVALID_REFERENCE,
]);

/** body-parser errors carry a string `type` and a 4xx `status`. */
function isClientBodyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { type?: unknown; status?: unknown };
  return (
    typeof e.type === 'string' && typeof e.status === 'number' && e.status >= 400 && e.status < 500
  );
}

function send(res: Response, status: number, body: ApiErrorBody): void {
  res.status(status).json(body);
}

export const apiErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  res.set('Cache-Control', 'no-store');

  if (err instanceof AppError) {
    if (err.code === ErrorCode.UNAUTHENTICATED) {
      logger.debug('[api] request unauthenticated', { code: err.code });
      res.set('WWW-Authenticate', 'Bearer');
      send(res, 401, { error: 'Unauthorized' });
      return;
    }
    if (NOT_FOUND_CODES.has(err.code)) {
      logger.debug('[api] request denied or not found', { code: err.code });
      send(res, 404, { error: 'Not found' });
      return;
    }
    if (err.code === ErrorCode.INVALID_REQUEST) {
      logger.debug('[api] invalid request', { code: err.code });
      send(res, 400, { error: 'Invalid request' });
      return;
    }
  } else if (isClientBodyError(err)) {
    logger.debug('[api] invalid request body', { type: (err as { type: string }).type });
    send(res, 400, { error: 'Invalid request' });
    return;
  }

  logger.error('[api] Unhandled error', err);
  send(res, 500, { error: 'Internal server error' });
};
