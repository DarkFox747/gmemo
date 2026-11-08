/**
 * Screenshots of the web screens (C8, demo-kit §5; insight views C12; search
 * explorer and revision diff C13). Run: pnpm screenshots
 *
 * Optional tooling: if Playwright (`@playwright/test`) is not installed or the
 * web build (packages/web/dist, change C7) is missing, it prints why and exits 0.
 * Otherwise it opens WEB_URL (default http://localhost:3000, the compose stack
 * serving the web) as the seeded tech lead and writes 1440x900 PNGs at
 * deviceScaleFactor 2 into docs/demo/capturas/. Each capture waits until the
 * screen heading is rendered and no loading view (aria-busy) remains.
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
/** Seeded constraint with three revisions (migrations/seed.dev.sql §10.5): shows the history diff. */
const HISTORY_MEMORY = '00000000-0000-0000-0000-000000000103';
/** Query typed into "Buscar como agente"; matches several seeded memories. */
const SEARCH_QUERY = 'customer notifications';
/** Browser-side readiness check: heading rendered, no loading view left. */
const LOADED = `document.querySelector('main h1') !== null && document.querySelector('main [aria-busy="true"]') === null`;
/** An error view on screen means the capture would document a failure, not the feature. */
const HAS_ALERT = `document.querySelector('main [role="alert"]') !== null`;
const WAIT_MS = 15_000;

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
  waitForFunction(expression: string, arg?: unknown, o?: { timeout: number }): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  waitForSelector(selector: string, o?: { timeout: number }): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
}

interface Screen {
  file: string;
  hash: string;
  /** Interaction after the screen loaded (e.g. submit a search). */
  act?: (page: Page) => Promise<void>;
  fullPage?: boolean;
}

/** Types a query into the explorer, submits it and waits for the results region to settle. */
async function runSearch(page: Page): Promise<void> {
  // The repo selector is enabled once the admin summary has loaded.
  await page.waitForSelector('main form[role="search"] select:not([disabled]) >> nth=1', {
    timeout: WAIT_MS,
  });
  await page.fill('main form[role="search"] input[type="search"]', SEARCH_QUERY);
  await page.click('main form[role="search"] button[type="submit"]');
  // data-state is set on the results region; the pre-search Empty view is "idle".
  await page.waitForSelector('main [data-state="ready"], main [data-state="error"]', {
    timeout: WAIT_MS,
  });
  await page.waitForFunction(LOADED, undefined, { timeout: WAIT_MS });
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
  const screens: Screen[] = [
    { file: '1-cola-de-revision.png', hash: '#/review' },
    { file: '2-detalle-de-revision.png', hash: `#/review/${itemId}` },
    { file: '3-cuarentena.png', hash: '#/quarantine' },
    { file: '4-memoria-del-proyecto.png', hash: '#/memory' },
    { file: '5-administracion.png', hash: '#/admin' },
    { file: '6-inicio.png', hash: '#/home' },
    { file: '7-actividad.png', hash: '#/activity' },
    { file: '8-area-de-preparacion.png', hash: '#/staging' },
    { file: '9-buscar-como-agente.png', hash: '#/search', act: runSearch },
    { file: '10-historial-de-versiones.png', hash: `#/memory/${HISTORY_MEMORY}`, fullPage: true },
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
    const failed: string[] = [];
    for (const s of screens) {
      try {
        // A full load per screen: a hash-only navigation could let the readiness
        // check pass on the previous screen's heading.
        await page.goto('about:blank', { waitUntil: 'networkidle' });
        await page.goto(`${WEB_URL}/${s.hash}`, { waitUntil: 'networkidle' });
        await page.waitForFunction(LOADED, undefined, { timeout: WAIT_MS });
        if (s.act) await s.act(page);
        if (await page.evaluate(HAS_ALERT))
          throw new Error('an error view (role="alert") is shown');
        await page.screenshot({ path: path.join(OUT_DIR, s.file), fullPage: s.fullPage ?? false });
        console.log(`[screenshots] ${s.file}`);
      } catch (err) {
        failed.push(s.file);
        console.error(
          `[screenshots] FAILED ${s.file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (failed.length > 0) {
      process.exitCode = 1;
      console.error(`[screenshots] ${failed.length} capture(s) failed: ${failed.join(', ')}`);
      return;
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
