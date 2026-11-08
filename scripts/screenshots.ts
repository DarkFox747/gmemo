/**
 * Screenshots of the five web screens (C8, demo-kit §5). Run: pnpm screenshots
 *
 * Optional tooling: if Playwright (`@playwright/test`) is not installed or the
 * web build (packages/web/dist, change C7) is missing, it prints why and exits 0.
 * Otherwise it opens WEB_URL (default http://localhost:3000, the compose stack
 * serving the web) as the seeded tech lead and writes 1440x900 PNGs at
 * deviceScaleFactor 2 into docs/demo/capturas/.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_BUILD = path.join(ROOT, 'packages', 'web', 'dist', 'index.html');
const OUT_DIR = path.join(ROOT, 'docs', 'demo', 'capturas');
const WEB_URL = (process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const PROJECT_ID = '00000000-0000-0000-0000-000000000010';
const TL = 'tl@demo.local';
/** Seeded uncertain queue item (migrations/seed.dev.sql §10.6), used if the queue is empty. */
const FALLBACK_ITEM = '00000000-0000-0000-0000-000000000301';

interface Browser {
  newContext(o: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
  }): Promise<Context>;
  close(): Promise<void>;
}
interface Context {
  addInitScript(script: string): Promise<void>;
  newPage(): Promise<Page>;
}
interface Page {
  goto(url: string, o: { waitUntil: 'networkidle' }): Promise<unknown>;
  screenshot(o: { path: string }): Promise<unknown>;
}

function skip(reason: string): never {
  console.log(`[screenshots] SKIP: ${reason}`);
  process.exit(0);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** First item of the review queue, so the detail screen always shows a live item. */
async function firstQueueItem(): Promise<string> {
  const res = await fetch(`${WEB_URL}/api/v1/projects/${PROJECT_ID}/review-queue`, {
    headers: { 'X-Dev-User': TL },
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} from the review queue`);
  const body = (await res.json()) as { items: Array<{ id: string }> };
  return body.items[0]?.id ?? FALLBACK_ITEM;
}

async function main(): Promise<void> {
  let chromium: { launch(): Promise<Browser> };
  try {
    // A variable specifier keeps this optional dependency out of static resolution.
    const moduleName = '@playwright/test';
    ({ chromium } = (await import(moduleName)) as { chromium: { launch(): Promise<Browser> } });
  } catch {
    skip(
      '@playwright/test is not installed (a human can add it with `pnpm add -D @playwright/test`).',
    );
  }
  if (!(await exists(WEB_BUILD))) {
    skip('the web build is missing (packages/web/dist/index.html; it comes with change C7).');
  }

  const itemId = await firstQueueItem();
  const screens = [
    { file: '1-cola-de-revision.png', hash: '#/review' },
    { file: '2-detalle-de-revision.png', hash: `#/review/${itemId}` },
    { file: '3-cuarentena.png', hash: '#/quarantine' },
    { file: '4-memoria-del-proyecto.png', hash: '#/memory' },
    { file: '5-administracion.png', hash: '#/admin' },
  ];

  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    // The web reads the dev user and project from localStorage (C7 design).
    await context.addInitScript(
      `localStorage.setItem('gmemo.devUser', '${TL}'); localStorage.setItem('gmemo.projectId', '${PROJECT_ID}');`,
    );
    const page = await context.newPage();
    for (const s of screens) {
      await page.goto(`${WEB_URL}/${s.hash}`, { waitUntil: 'networkidle' });
      await page.screenshot({ path: path.join(OUT_DIR, s.file) });
      console.log(`[screenshots] ${s.file}`);
    }
  } finally {
    await browser.close();
  }
  console.log(`[screenshots] ${screens.length} capturas en ${path.relative(ROOT, OUT_DIR)}`);
}

main().catch((err: unknown) => {
  console.error(`[screenshots] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
