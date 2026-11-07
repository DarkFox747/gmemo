/**
 * Stateless Streamable HTTP transport wiring for the MCP facade.
 *
 * Per the infra topology (ALB + stateless Fargate/EC2), each POST /mcp
 * creates a fresh StreamableHTTPServerTransport + McpServer pair.
 * No in-memory session state is held between requests.
 *
 * GET /mcp and DELETE /mcp return 405 — there is no server-initiated
 * SSE stream in stateless mode.
 *
 * Design decision: MCP over stateless Streamable HTTP (design.md §Architecture).
 */

import type { NextFunction, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AppServices, Deps, TenantResolutionInput } from './context.js';
import { createMcpServer } from './server.js';

/**
 * Returns a stateless POST /mcp Express handler that closes over the boot-time
 * AuthServices singletons (built once at process start, never per-request).
 *
 * Per request the handler:
 *  1. Extracts Authorization, X-Git-Remote, and X-Git-Branch headers into
 *     resolutionInput (array-safe: takes first element when the header is repeated).
 *  2. Spreads services + resolutionInput into a Deps bag.
 *  3. Creates a fresh McpServer + StreamableHTTPServerTransport pair and delegates
 *     to transport.handleRequest().
 *
 * server.close() runs in a finally block to release SDK-internal resources on
 * every outcome — success, error, or early close. On error, next(err) is called
 * if headers have not been sent, letting the terminal Express error handler
 * (app.ts) return a generic opaque 500.
 */
export function makeMcpPostHandler(
  services: AppServices,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const resolutionInput: TenantResolutionInput = {
      authorization: Array.isArray(req.headers['authorization'])
        ? req.headers['authorization'][0]
        : req.headers['authorization'],
      gitRemote: Array.isArray(req.headers['x-git-remote'])
        ? req.headers['x-git-remote'][0]
        : req.headers['x-git-remote'],
      branch: Array.isArray(req.headers['x-git-branch'])
        ? req.headers['x-git-branch'][0]
        : req.headers['x-git-branch'],
    };

    const deps: Deps = { ...services, resolutionInput };
    const server = createMcpServer(deps);

    // sessionIdGenerator: undefined enables stateless mode (no persistent sessions).
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      // Forward to the terminal error handler only if headers have not been sent.
      // Never leak internal detail.
      if (!res.headersSent) {
        next(err);
      }
    } finally {
      // Always release SDK-internal resources regardless of outcome.
      void server.close();
    }
  };
}

/** GET /mcp — not supported in stateless mode (no server-initiated SSE stream). */
export function handleMcpGet(_req: Request, res: Response): void {
  res.status(405).json({ error: 'Method Not Allowed' });
}

/** DELETE /mcp — not supported in stateless mode. */
export function handleMcpDelete(_req: Request, res: Response): void {
  res.status(405).json({ error: 'Method Not Allowed' });
}
