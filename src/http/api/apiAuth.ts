/**
 * Gate 1 for /api — authenticates the request and stores the Principal in
 * res.locals.principal. Any Gate-1 failure becomes AppError(UNAUTHENTICATED)
 * (401 via apiErrorHandler).
 *
 * X-Dev-User (design D1, production guard layer 2): forwarded to the
 * authenticator as `devUser` ONLY when the factory flag `devUserHeader` is true
 * AND NODE_ENV !== 'production' at factory time. Otherwise it is never read.
 * The header value is never logged.
 */

import type { NextFunction, Request } from 'express';
import { AppError, ErrorCode } from '../../errors/appError.js';
import type { AuthenticateOptions, Authenticator, Principal } from '../../mcp/context.js';
import type { ApiResponse, ApiRouterOptions } from './types.js';

/** First value when a header is repeated (same rule as the MCP transport). */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function makeApiAuth(
  authenticator: Authenticator,
  o: ApiRouterOptions,
): (req: Request, res: ApiResponse, next: NextFunction) => Promise<void> {
  const headerAllowed = o.devUserHeader && process.env.NODE_ENV !== 'production';

  return async (req: Request, res: ApiResponse, next: NextFunction): Promise<void> => {
    const devUser = headerAllowed ? firstHeader(req.headers['x-dev-user']) : undefined;
    const opts: AuthenticateOptions | undefined = devUser !== undefined ? { devUser } : undefined;

    let principal: Principal;
    try {
      principal = await authenticator.authenticate(firstHeader(req.headers.authorization), opts);
    } catch (err) {
      next(new AppError(ErrorCode.UNAUTHENTICATED, err));
      return;
    }
    res.locals.principal = principal;
    next();
  };
}
