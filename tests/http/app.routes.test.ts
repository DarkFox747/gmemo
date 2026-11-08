/**
 * createApp route composition with and without the dev static web:
 * the SPA never shadows /health, /mcp, /promote or /api.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type express from 'express';
import { createApp } from '../../src/http/app.js';
import { makeStubAuthServices } from '../auth/fakes.js';

const INDEX = '<!doctype html><title>gmemo-web</title>';

let dir: string;
let app: express.Express;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmemo-app-routes-'));
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX);
  app = createApp(makeStubAuthServices(), { webStaticDir: dir });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createApp with webStaticDir', () => {
  it('GET / → the web index with CSP', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toBe(INDEX);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('GET /health → JSON, not the SPA', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('GET /mcp → 405', async () => {
    const res = await request(app).get('/mcp');
    expect(res.status).toBe(405);
    expect(res.text).not.toContain('gmemo-web');
  });

  it('GET /promote → not the SPA (keeps its current mapping)', async () => {
    const res = await request(app).get('/promote');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('gmemo-web');
  });

  it('GET /api/v1/unknown → JSON 404, not index.html', async () => {
    const res = await request(app).get('/api/v1/unknown');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.text).toBe('{"error":"Not found"}');
  });
});

describe('createApp without webStaticDir', () => {
  it('GET / → 404', async () => {
    const res = await request(createApp(makeStubAuthServices())).get('/');
    expect(res.status).toBe(404);
  });
});
