import type { Request, Response } from 'express';

/**
 * GET /health — unauthenticated liveness probe.
 * Returns 200 { status: "ok" } so the ALB and container orchestrator can
 * confirm the process has booted and is accepting requests.
 */
export function healthHandler(_req: Request, res: Response): void {
  res.status(200).json({ status: 'ok' });
}
