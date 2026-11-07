# Desarrollo — gmemo

Servicio de memoria compartida (facade MCP + `POST /promote`). El diseño vive en `docs/` (empezar por
`docs/09-decisiones-abiertas.md`). El esquema de referencia está en `docs/artefactos/gmemo_schema_v2.sql` y el
contrato del facade en `docs/artefactos/gmemo_facade_contract_v1.md`.

## Estructura

```
src/            # servidor (Express + facade MCP, TypeScript)
migrations/     # migraciones SQL numeradas + seed.dev.sql
scripts/        # smoke.ts (prueba de humo)
packages/web/   # @gmemo/web — futura web de administración/curación (solo manifest + README)
terraform/      # IaC
docs/           # diseño + memoria de decisiones
```

El servidor vive en la raíz del repo. `packages/web` es un workspace pnpm aparte; para agregarle dependencias:
`pnpm add <pkg> --filter @gmemo/web`.

## Requisitos

- Docker Desktop (alcanza para levantar todo el stack).
- Para trabajar en el host: Node >= 22 y pnpm 9 (`corepack enable`; la versión queda fijada en
  `package.json → packageManager`). Solo pnpm: no usar npm, yarn ni bun.

## Arranque

```bash
docker compose up --build
```

Levanta Postgres (`pgvector/pgvector:pg16`, db/usuario/password `gmemo`), corre las migraciones y el seed de
desarrollo (servicio one-shot `migrate`) y arranca la app (imagen `gmemo:dev`) en http://localhost:3000.

> **Solo para desarrollo local.** Las credenciales del compose y los bypass de autenticación son de
> desarrollo: los puertos se publican únicamente en `127.0.0.1`. No reutilices este compose en un host
> compartido ni para desplegar.

```
GET http://localhost:3000/health
→ 200  { "status": "ok" }
```

Resetear todo (borra el volumen de la base y vuelve al estado del seed):

```bash
docker compose down -v
```

> El build de la imagen descarga el bundle de CA de RDS: **necesita internet**.

Compose define en la app los bypass/stubs de desarrollo: `AUTH_DEV_BYPASS`, `JUDGE_STUB` (con
`JUDGE_STUB_VERDICT=accepted`), `PROMOTE_OIDC_DEV_BYPASS` y `EMBEDDER_STUB`. No hace falta AWS.

> **Guard de producción.** Todos esos bypass/stubs (y `RATE_LIMIT_ENABLED=false`) son rechazados por
> `src/config/index.ts` cuando `NODE_ENV=production`: el servidor sale con código 1 al arrancar.

## Smoke test

Con el stack arriba:

```bash
pnpm smoke
# contra otra URL:
BASE_URL=http://localhost:3000 pnpm smoke
```

Corre, en orden y cortando en el primer fallo: `GET /health`, `initialize` MCP, `recall`, `remember`,
`list_staged`, `POST /promote` y un segundo `/promote` idempotente (`no_op`). Imprime `PASS <paso>` /
`FAIL <paso>: <motivo>`. Se puede repetir sin `docker compose down -v`.

Códigos de salida: `0` todo OK · `1` falló una verificación · `2` el stack no responde (¿está corriendo
`docker compose up`?).

## Desarrollo en el host

Para correr el server en el host contra el Postgres de compose:

```bash
pnpm install
docker compose up -d db          # solo la base
cp .env.dev.example .env         # variables para el host
pnpm migrate
pnpm seed:dev
pnpm dev                         # http://localhost:3000
```

Compose **no** lee `.env.dev.example`: ese archivo es solo para el trabajo en el host (`pnpm dev`, tests).

El Postgres de compose se publica en el puerto **5433** del host (`5433:5432`), para no chocar con un PostgreSQL local
en 5432. El `DATABASE_URL` del host debe apuntar a `localhost:5433` (`postgres://gmemo:gmemo@localhost:5433/gmemo`).

Las variables de la app dentro de compose están definidas en `docker-compose.yml`.

## Scripts

| Script | Qué hace |
|---|---|
| `pnpm dev` | server en watch (`tsx watch src/index.ts`) |
| `pnpm build` | compila TypeScript a `dist/` |
| `pnpm start` | corre el build (`node dist/index.js`) |
| `pnpm test` | Vitest (en watch; usar `pnpm test -- --run` para una sola pasada) |
| `pnpm lint` | ESLint sobre `src`, `tests` y `scripts` |
| `pnpm format` | Prettier |
| `pnpm migrate` | aplica las migraciones numeradas |
| `pnpm provision` | provisiona roles de la base |
| `pnpm seed:dev` | carga el seed de desarrollo (solo dev) |
| `pnpm smoke` | prueba de humo contra un stack corriendo |

## Tests

```bash
pnpm test -- --run
```

Los tests de integración con DB necesitan `DATABASE_URL` apuntando al Postgres de compose (ver
`.env.dev.example`); sin esa variable se saltean.

## Probar a mano

Datos del seed: proyecto `gmemo`, remote `https://github.com/crombie-llc/gmemo-demo.git`, usuario dev
`contributor`. No hace falta header `Authorization` en `/mcp`.

```bash
curl -sS http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-Git-Remote: https://github.com/crombie-llc/gmemo-demo.git' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recall","arguments":{"query":"pnpm"}}}'
```

`/promote` en dev (el bypass OIDC acepta cualquier bearer):

```bash
curl -sS http://localhost:3000/promote \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer dev-smoke' \
  -d '{"repo":"crombie-llc/gmemo-demo","source_branch":"main"}'
```
