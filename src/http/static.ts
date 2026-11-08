/**
 * DEV-ONLY static serving of the web build (WEB_STATIC_DIR).
 *
 * config forbids WEB_STATIC_DIR under production and index.ts only passes it
 * outside production. In production the web is served from S3 + CloudFront,
 * which sets the CSP as a response-headers policy (see DEVELOPMENT.md).
 *
 * - A strict same-origin CSP + `Cache-Control: no-cache` on HTML responses only
 *   (the global helmet CSP stays off so JSON/MCP responses are unaffected).
 * - SPA fallback: GET/HEAD, extension-less paths, never /api, /mcp, /promote
 *   or /health.
 */

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';

export const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const NOT_SPA = /^\/(?:api|mcp|promote|health)(?:\/|$)/i;

function setHtmlHeaders(res: Response): void {
  res.set('Content-Security-Policy', WEB_CSP);
  res.set('Cache-Control', 'no-cache');
}

export function mountWebStatic(app: express.Express, dir: string): void {
  const root = path.resolve(dir);
  // Fail fast at boot rather than serving 404s for every page.
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    throw new Error(`[static] index.html not found in WEB_STATIC_DIR (${root})`);
  }

  app.use(
    express.static(root, {
      index: 'index.html',
      dotfiles: 'ignore',
      redirect: false,
      setHeaders: (res, file) => {
        if (file.endsWith('.html')) setHtmlHeaders(res);
        else if (file.endsWith('.svg')) res.set('Content-Security-Policy', WEB_CSP);
      },
    }),
  );

  app.use((req: Request, res: Response, next: NextFunction): void => {
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (!isRead || NOT_SPA.test(req.path) || path.extname(req.path) !== '') {
      next();
      return;
    }
    setHtmlHeaders(res);
    res.sendFile('index.html', { root }, (err?: Error) => {
      if (err) next(err);
    });
  });
}
