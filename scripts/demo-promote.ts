/**
 * Promote a branch through the running compose stack (demo helper).
 *
 * Run: pnpm demo:promote -- --branch feature/x --pr 101   (BASE_URL defaults to http://localhost:3000)
 * A BASE_URL other than localhost / 127.0.0.1 is refused unless --force is given.
 *
 * Calls POST /promote through the dev OIDC bypass (no token needed), like the
 * promote.yml workflow does after a merge. A feature branch needs --pr (the
 * merged PR's number); `main` does not. Exit 0 = promoted, 1 = usage error or
 * the server refused, 2 = stack unreachable.
 */

import { parseArgs } from 'node:util';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const REPO = 'crombie-llc/gmemo-demo';
const MAIN = 'main';

const USAGE =
  'Uso: pnpm demo:promote -- --branch <rama> [--pr <numero>] [--force]  (la rama feature exige --pr)';

function usage(reason: string): never {
  console.error(`${reason}\n${USAGE}`);
  process.exit(1);
}

let values: { branch?: string; pr?: string; force?: boolean };
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      branch: { type: 'string' },
      pr: { type: 'string' },
      force: { type: 'boolean' },
    },
  }));
} catch (err) {
  usage(err instanceof Error ? err.message : String(err));
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
let host: string;
try {
  host = new URL(BASE_URL).hostname;
} catch {
  usage(`BASE_URL invalida: ${BASE_URL}`);
}
if (!LOCAL_HOSTS.includes(host) && !values.force) {
  usage(`BASE_URL ${BASE_URL} no es localhost/127.0.0.1; usa --force si es intencional.`);
}

const branch = values.branch ?? MAIN;
let prNumber: number | undefined;
if (values.pr !== undefined) {
  prNumber = Number(values.pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) usage(`--pr invalido: ${values.pr}`);
}
if (branch !== MAIN && prNumber === undefined) usage(`La rama ${branch} requiere --pr.`);

/** Prints status and every numeric counter of the response; falls back to the raw body. */
function printOutcome(text: string): void {
  const header = `/promote ${branch}${prNumber !== undefined ? ` (PR #${prNumber})` : ''}`;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    console.log(`${header}: ${text}`);
    return;
  }
  if (typeof body !== 'object' || body === null) {
    console.log(`${header}: ${text}`);
    return;
  }
  const entries = Object.entries(body as Record<string, unknown>);
  console.log(`${header}: OK (200)`);
  for (const [key, value] of entries) {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      console.log(`  ${key}: ${value}`);
    } else {
      console.log(`  ${key}: ${JSON.stringify(value)}`);
    }
  }
}

async function main(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dev-demo' },
      body: JSON.stringify({ repo: REPO, source_branch: branch, pr_number: prNumber }),
    });
  } catch (err) {
    console.error(
      `No se pudo conectar con ${BASE_URL}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
  const text = await res.text();
  if (res.status !== 200) {
    console.error(`/promote respondio ${res.status}: ${text}`);
    process.exit(1);
  }
  printOutcome(text);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
