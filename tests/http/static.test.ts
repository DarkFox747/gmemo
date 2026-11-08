/**
 * Dev-only static web serving: files, SPA fallback, HTML-only CSP.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { WEB_CSP, mountWebStatic } from '../../src/http/static.js';

let dir: string;
let app: express.Express;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmemo-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>gmemo</title>');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1);');
  fs.writeFileSync(path.join(dir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');

  app = express();
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  mountWebStatic(app, dir);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('mountWebStatic', () => {
  it('GET / → index.html with CSP + no-cache', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>gmemo</title>');
    expect(res.headers['content-security-policy']).toBe(WEB_CSP);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('GET /deep/route → SPA fallback index.html with CSP', async () => {
    const res = await request(app).get('/review/queue/123');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-security-policy']).toBe(WEB_CSP);
  });

  it('GET /assets/app.js → the asset with NO CSP', async () => {
    const res = await request(app).get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('console.log(1)');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('GET /assets/logo.svg -> the SVG with the CSP', async () => {
    const res = await request(app).get('/assets/logo.svg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
    expect(res.headers['content-security-policy']).toBe(WEB_CSP);
  });

  it.each(['/API/v1/x', '/Mcp', '/PROMOTE', '/Health/x'])(
    'GET %s (mixed case) never falls back to the SPA',
    async (p) => {
      const res = await request(app).get(p);
      expect(res.text).not.toContain('<title>gmemo</title>');
    },
  );

  it('GET /missing.png → 404, not index.html', async () => {
    const res = await request(app).get('/missing.png');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<title>gmemo</title>');
  });

  it('dotfiles are not served (the extension-less path may fall back to index.html)', async () => {
    const res = await request(app).get('/.env');
    expect(res.text).not.toContain('SECRET');
  });

  it('POST /x → not the fallback', async () => {
    const res = await request(app).post('/x');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<title>gmemo</title>');
  });

  it.each(['/api/v1/unknown', '/api', '/mcp', '/promote', '/health/x'])(
    'GET %s never falls back to the SPA',
    async (p) => {
      const res = await request(app).get(p);
      expect(res.text).not.toContain('<title>gmemo</title>');
    },
  );

  it('CSP is strict same-origin', () => {
    expect(WEB_CSP).toContain("default-src 'self'");
    expect(WEB_CSP).toContain("frame-ancestors 'none'");
    expect(WEB_CSP).toContain("object-src 'none'");
    expect(WEB_CSP).not.toContain('unsafe-inline');
  });

  it('throws at boot when index.html is missing', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gmemo-web-empty-'));
    try {
      expect(() => mountWebStatic(express(), empty)).toThrow();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
