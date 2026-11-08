/**
 * Smoke test against a running gmemo dev stack (`docker compose up --build`).
 *
 * Run: pnpm smoke   (BASE_URL defaults to http://localhost:3000)
 *
 * Speaks raw JSON-RPC over Streamable HTTP with `fetch` (no MCP SDK client), so it
 * documents the wire contract. Fail-fast; exit 0 = all pass, 1 = a check failed,
 * 2 = stack unreachable.
 */

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const REMOTE = 'https://github.com/crombie-llc/gmemo-demo.git';
const REPO = 'crombie-llc/gmemo-demo';
const BRANCH = 'main';
/** Seeded demo project + tech lead (migrations/seed.dev.sql section 9). */
const DEMO_PROJECT_ID = '00000000-0000-0000-0000-000000000010';
const DEMO_TL = 'tl@demo.local';
const DEMO_VIEWER = 'viewer@demo.local';
const TIMEOUT_MS = 10_000;

const runId = Date.now().toString(36);

class StepError extends Error {}

let nextId = 1;
let protocolVersion: string | undefined;

function fail(reason: string): never {
  throw new StepError(reason);
}

function request(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** Extracts the JSON-RPC message with the given id from an SSE body. */
function parseSse(text: string, id: number): unknown {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    const message = JSON.parse(data) as { id?: number };
    if (message.id === id) return message;
  }
  return fail(`no SSE message with id ${id}`);
}

interface RpcResponse {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-Git-Remote': REMOTE,
    'X-Git-Branch': BRANCH,
  };
  if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;

  const res = await request('/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!res.ok) fail(`HTTP ${res.status} from /mcp`);

  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  const message = (contentType.includes('text/event-stream')
    ? parseSse(text, id)
    : JSON.parse(text)) as RpcResponse;

  if (message.error) fail(`JSON-RPC error ${message.error.code ?? '?'}: ${message.error.message ?? ''}`);
  if (!message.result) fail('response has no result');
  return message.result;
}

/** tools/call → parsed JSON payload of result.content[0].text. */
async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await rpc('tools/call', { name, arguments: args });
  if (result.isError === true) fail(`tool ${name} returned isError`);
  const content = result.content as Array<{ text?: string }> | undefined;
  const text = content?.[0]?.text;
  if (typeof text !== 'string') fail(`tool ${name} returned no text content`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function promote(): Promise<Record<string, unknown>> {
  const res = await request('/promote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dev-smoke' },
    body: JSON.stringify({ repo: REPO, source_branch: BRANCH }),
  });
  if (res.status !== 200) fail(`HTTP ${res.status} from /promote`);
  return (await res.json()) as Record<string, unknown>;
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`FAIL ${name}: ${reason}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  let stagedId = '';

  // Step 1 is the only one where a network error means "stack unreachable".
  try {
    const res = await request('/health', { method: 'GET' });
    if (res.status !== 200) fail(`HTTP ${res.status} from /health`);
    const body = (await res.json()) as { status?: string };
    if (body.status !== 'ok') fail(`status is ${String(body.status)}, expected "ok"`);
    console.log('PASS health');
  } catch (err) {
    if (err instanceof StepError) {
      console.error(`FAIL health: ${err.message}`);
      process.exit(1);
    }
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`FAIL health: ${reason} (is \`docker compose up\` running?)`);
    process.exit(2);
  }

  await step('initialize', async () => {
    const result = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'gmemo-smoke', version: '0' },
    });
    const name = (result.serverInfo as { name?: string } | undefined)?.name;
    if (name !== 'gmemo') fail(`serverInfo.name is ${String(name)}, expected "gmemo"`);
    protocolVersion = result.protocolVersion as string | undefined;
    if (!protocolVersion) fail('initialize returned no protocolVersion');
  });

  await step('recall', async () => {
    const payload = await callTool('recall', { query: 'pnpm' });
    const results = payload.results as unknown[] | undefined;
    if (!Array.isArray(results) || results.length < 1) fail('recall returned no results');
  });

  await step('remember', async () => {
    const payload = await callTool('remember', {
      op: 'add',
      type: 'gotcha',
      title: `Smoke ${runId}`,
      summary: `Smoke test item ${runId}`,
      body: `Created by scripts/smoke.ts, run ${runId}.`,
    });
    if (typeof payload.id !== 'string') fail('remember returned no string id');
    if (payload.state !== 'pending' && payload.state !== 'uncertain') {
      fail(`state is ${String(payload.state)}, expected pending or uncertain`);
    }
    stagedId = payload.id;
  });

  await step('list_staged', async () => {
    const payload = await callTool('list_staged', {});
    const items = payload.items as Array<{ id?: string }> | undefined;
    if (!Array.isArray(items) || !items.some((item) => item.id === stagedId)) {
      fail('list_staged does not contain the remembered item');
    }
  });

  await step('promote', async () => {
    const outcome = await promote();
    if (outcome.status !== 'promoted' && outcome.status !== 'partially_promoted') {
      fail(`status is ${String(outcome.status)}, expected promoted or partially_promoted`);
    }
    if (typeof outcome.applied !== 'number' || outcome.applied < 1) {
      fail(`applied is ${String(outcome.applied)}, expected >= 1`);
    }
  });

  await step('promote idempotent', async () => {
    const outcome = await promote();
    if (outcome.status !== 'no_op') fail(`status is ${String(outcome.status)}, expected "no_op"`);
    if (outcome.applied !== 0) fail(`applied is ${String(outcome.applied)}, expected 0`);
  });

  await step('api me as tech lead', async () => {
    const res = await request('/api/v1/me', { method: 'GET', headers: { 'X-Dev-User': DEMO_TL } });
    if (res.status !== 200) fail(`HTTP ${res.status} from /api/v1/me`);
    const body = (await res.json()) as {
      user?: { email?: string };
      projects?: Array<{ id?: string; role?: string }>;
    };
    if (body.user?.email !== DEMO_TL) fail(`user.email is ${String(body.user?.email)}, expected ${DEMO_TL}`);
    const role = body.projects?.find((p) => p.id === DEMO_PROJECT_ID)?.role;
    if (role !== 'project_admin') fail(`role on the demo project is ${String(role)}, expected project_admin`);
  });

  await step('api me as viewer', async () => {
    const res = await request('/api/v1/me', { method: 'GET', headers: { 'X-Dev-User': DEMO_VIEWER } });
    if (res.status !== 200) fail(`HTTP ${res.status} from /api/v1/me`);
    const body = (await res.json()) as { projects?: Array<{ id?: string; role?: string }> };
    const role = body.projects?.find((p) => p.id === DEMO_PROJECT_ID)?.role;
    if (role !== 'viewer') fail(`role on the demo project is ${String(role)}, expected viewer`);
  });

  await step('api review-queue as tech lead', async () => {
    const res = await request(`/api/v1/projects/${DEMO_PROJECT_ID}/review-queue`, {
      method: 'GET',
      headers: { 'X-Dev-User': DEMO_TL },
    });
    if (res.status !== 200) fail(`HTTP ${res.status} from review-queue`);
    const body = (await res.json()) as { items?: unknown; counters?: unknown };
    if (!Array.isArray(body.items)) fail('review-queue response has no items array');
    if (typeof body.counters !== 'object' || body.counters === null) {
      fail('review-queue response has no counters');
    }
  });

  await step('api review-queue as viewer is opaque 404', async () => {
    const res = await request(`/api/v1/projects/${DEMO_PROJECT_ID}/review-queue`, {
      method: 'GET',
      headers: { 'X-Dev-User': DEMO_VIEWER },
    });
    if (res.status !== 404) fail(`HTTP ${res.status}, expected 404`);
    const text = await res.text();
    if (text !== '{"error":"Not found"}') fail(`body is ${text}, expected {"error":"Not found"}`);
  });

  await step('api quarantine as tech lead', async () => {
    const res = await request(`/api/v1/projects/${DEMO_PROJECT_ID}/quarantine`, {
      method: 'GET',
      headers: { 'X-Dev-User': DEMO_TL },
    });
    if (res.status !== 200) fail(`HTTP ${res.status} from quarantine`);
    const body = (await res.json()) as { items?: unknown; truncated?: unknown };
    if (!Array.isArray(body.items)) fail('quarantine response has no items array');
    if (typeof body.truncated !== 'boolean') fail('quarantine response has no truncated flag');
  });

  await step('job quarantine-purge (dev open mode)', async () => {
    const res = await request('/internal/jobs/quarantine-purge', { method: 'POST' });
    if (res.status !== 200) fail(`HTTP ${res.status} from /internal/jobs/quarantine-purge`);
    const body = (await res.json()) as { job?: unknown; count?: unknown };
    if (body.job !== 'quarantine-purge') fail(`job is ${String(body.job)}, expected quarantine-purge`);
    if (typeof body.count !== 'number') fail('purge response has no numeric count');
  });

  await step('api memories pending_revalidation as tech lead', async () => {
    const res = await request(
      `/api/v1/projects/${DEMO_PROJECT_ID}/memories?status=pending_revalidation`,
      { method: 'GET', headers: { 'X-Dev-User': DEMO_TL } },
    );
    if (res.status !== 200) fail(`HTTP ${res.status} from memories`);
    const body = (await res.json()) as { items?: unknown; truncated?: unknown };
    if (!Array.isArray(body.items)) fail('memories response has no items array');
    if (typeof body.truncated !== 'boolean') fail('memories response has no truncated flag');
  });

  // C5 (HU-13): direct memory management as the tech lead. The unit is unique per
  // run (runId) so the smoke can run repeatedly against the same stack.
  const directUnit = {
    type: 'gotcha',
    title: `Smoke direct gotcha ${runId}`,
    summary: `Direct web write from the smoke test, run ${runId}.`,
    body: `Set SMOKE_RETRY_MAX=3 in scripts/smoke.ts; marker direct${runId}.`,
    fields: { symptom: 'flaky smoke' },
  };
  const memoriesPath = `/api/v1/projects/${DEMO_PROJECT_ID}/memories`;
  const jsonAs = (user: string) => ({ 'Content-Type': 'application/json', 'X-Dev-User': user });
  let directMemoryId = '';

  await step('api memory preview as tech lead', async () => {
    const res = await request(`${memoriesPath}/preview`, {
      method: 'POST',
      headers: jsonAs(DEMO_TL),
      body: JSON.stringify({ op: 'add', ...directUnit }),
    });
    if (res.status !== 200) fail(`HTTP ${res.status} from memories/preview`);
    const body = (await res.json()) as { outcome?: unknown; judge?: { verdict?: unknown } | null };
    if (body.outcome !== 'apply') fail(`outcome is ${String(body.outcome)}, expected apply`);
    if (typeof body.judge?.verdict !== 'string') fail('preview has no judge verdict');
  });

  await step('api memory create as tech lead (web_ui, version 1)', async () => {
    const res = await request(memoriesPath, {
      method: 'POST',
      headers: jsonAs(DEMO_TL),
      body: JSON.stringify({ ...directUnit, confirm: true }),
    });
    if (res.status !== 200) fail(`HTTP ${res.status} from POST memories`);
    const body = (await res.json()) as {
      outcome?: unknown;
      memory?: { id?: string; provenance?: unknown; version?: unknown };
    };
    if (body.outcome !== 'applied') fail(`outcome is ${String(body.outcome)}, expected applied`);
    if (body.memory?.provenance !== 'web_ui') fail(`provenance is ${String(body.memory?.provenance)}`);
    if (body.memory?.version !== 1) fail(`version is ${String(body.memory?.version)}, expected 1`);
    directMemoryId = body.memory.id ?? '';
  });

  await step('api memory detail shows one revision', async () => {
    const res = await request(`${memoriesPath}/${directMemoryId}`, {
      method: 'GET',
      headers: { 'X-Dev-User': DEMO_TL },
    });
    if (res.status !== 200) fail(`HTTP ${res.status} from memory detail`);
    const body = (await res.json()) as { revisions?: unknown[] };
    if (body.revisions?.length !== 1) fail(`revisions: ${String(body.revisions?.length)}, expected 1`);
  });

  await step('api memories search finds the direct write', async () => {
    const res = await request(`${memoriesPath}?q=${encodeURIComponent(`direct${runId}`)}`, {
      method: 'GET',
      headers: { 'X-Dev-User': DEMO_TL },
    });
    if (res.status !== 200) fail(`HTTP ${res.status} from memories search`);
    const body = (await res.json()) as { items?: Array<{ id?: string }>; nextCursor?: unknown };
    if (!body.items?.some((i) => i.id === directMemoryId)) fail('search does not return the memory');
    if (body.nextCursor !== null) fail('nextCursor should be null for a single hit');
  });

  await step('api memory create as viewer is opaque 404', async () => {
    const res = await request(memoriesPath, {
      method: 'POST',
      headers: jsonAs(DEMO_VIEWER),
      body: JSON.stringify({ ...directUnit, title: `Viewer ${runId}`, confirm: true }),
    });
    if (res.status !== 404) fail(`HTTP ${res.status}, expected 404`);
    const text = await res.text();
    if (text !== '{"error":"Not found"}') fail(`body is ${text}, expected {"error":"Not found"}`);
  });

  await step('job revalidation-sweep (dev open mode)', async () => {
    const res = await request('/internal/jobs/revalidation-sweep', { method: 'POST' });
    if (res.status !== 200) fail(`HTTP ${res.status} from /internal/jobs/revalidation-sweep`);
    const body = (await res.json()) as { job?: unknown; count?: unknown };
    if (body.job !== 'revalidation-sweep') {
      fail(`job is ${String(body.job)}, expected revalidation-sweep`);
    }
    if (typeof body.count !== 'number') fail('sweep response has no numeric count');
  });
}

main().catch((err: unknown) => {
  console.error(`FAIL unexpected: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
