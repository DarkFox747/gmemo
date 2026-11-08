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

Compose define en la app los bypass/stubs de desarrollo: `AUTH_DEV_BYPASS`, `JUDGE_STUB` (juez
determinista), `PROMOTE_OIDC_DEV_BYPASS` y `EMBEDDER_STUB`. No hace falta AWS.

El juez determinista (`JUDGE_STUB`) no devuelve un veredicto fijo: aplica reglas ordenadas (la primera que
coincide gana). En resumen: revela credenciales en lenguaje natural o blobs codificados → rechazado
(`security_second_layer`); cuerpo demasiado corto o título genérico → rechazado (`specificity`); título
igual a una memoria existente → rechazado (`duplication`); título muy parecido en el mismo tipo →
incierto (`contradiction`); `gotcha`/`integration_note` sin referencia concreta → incierto (`grounding`);
lenguaje dubitativo → aceptado con confianza 0.6 (menor que el umbral, va a revisión); resto → aceptado
con `JUDGE_STUB_CONFIDENCE`. La tabla completa está en
`openspec/changes/judge-structured-verdict/design.md`.

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
`list_staged`, `POST /promote`, un segundo `/promote` idempotente (`no_op`) y `GET /api/v1/me` como
`tl@demo.local` (debe ser `project_admin` del proyecto del seed). Imprime `PASS <paso>` /
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
| `pnpm job:quarantine-purge` | borra las entradas de cuarentena vencidas (`expires_at < now()`) e imprime el conteo; lee solo `DATABASE_URL` |

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

`closed_unmerged` en dev (PR cerrado sin merge: abandona la sesión abierta de la rama y descarta sus items
no promovidos). El bypass OIDC usa `refs/heads/<source_branch>` como ref; la rama no puede ser la default:

```bash
curl -sS http://localhost:3000/promote   -H 'Content-Type: application/json'   -H 'Authorization: Bearer dev-smoke'   -d '{"repo":"crombie-llc/gmemo-demo","source_branch":"feature/x","pr_number":7,"event":"closed_unmerged"}'
# → {"status":"abandoned","discarded":N}  ·  repetido → {"status":"no_op","discarded":0}
```

## API REST (`/api/v1`) en dev

Con `AUTH_DEV_BYPASS=true` (solo dev) la API acepta el header `X-Dev-User: <email>` y actúa como ese
usuario **existente y habilitado**; Gate 2 (membresías reales), RBAC y audit corren de verdad. Sin el header
actúa como el usuario dev por defecto (`dev@localhost`, contributor). Un email desconocido da 401. Con
`NODE_ENV=production` el header no tiene ningún efecto (config, composición, transporte y autenticador lo
bloquean por separado).

Usuarios demo del seed (proyecto `00000000-0000-0000-0000-000000000010`):

| Email | Rol en el proyecto |
|---|---|
| `tl@demo.local` | `project_admin` (puede usar la cola de revisión) |
| `dev@demo.local` | `contributor` |
| `viewer@demo.local` | `viewer` |

```bash
P=00000000-0000-0000-0000-000000000010
# identidad + proyectos con rol
curl -sS http://localhost:3000/api/v1/me -H 'X-Dev-User: tl@demo.local'
# cola de revisión (solo project_admin; cualquier otro recibe el mismo 404 que un proyecto inexistente)
curl -sS "http://localhost:3000/api/v1/projects/$P/review-queue?filter=all" -H 'X-Dev-User: tl@demo.local'
curl -sS http://localhost:3000/api/v1/projects/$P/review-queue/<itemId> -H 'X-Dev-User: tl@demo.local'
# aprobar (targetRevision confirma la versión vista si el target cambió) / rechazar (motivo 3-500 chars)
curl -sS -X POST http://localhost:3000/api/v1/projects/$P/review-queue/<itemId>/approve   -H 'X-Dev-User: tl@demo.local' -H 'Content-Type: application/json' -d '{"markRelatedSuperseded":false}'
curl -sS -X POST http://localhost:3000/api/v1/projects/$P/review-queue/<itemId>/reject   -H 'X-Dev-User: tl@demo.local' -H 'Content-Type: application/json' -d '{"reason":"too vague"}'
```

Errores: 401 `{"error":"Unauthorized"}`, 404 `{"error":"Not found"}` (también para cualquier falta de
permiso), 400 `{"error":"Invalid request"}` (nunca repite la entrada), 409 `{"error":"Conflict","code":...}`
al aprobar (`target_changed`, `target_inactive`, `duplicate_content`), 429 al superar
`RATE_LIMIT_API_MAX`. Todas las respuestas llevan `Cache-Control: no-store`.

### Cuarentena (HU-10)

Cada entrada guarda el criterio (`pipeline`, `judge`, `human_review`), el motivo (`secret_detected`,
`embedded_instructions`, `duplicate_content`, `judge_rejected`, `human_rejected`, `sanitize_failed`; el
motivo fino del juez queda en `judgeReason`), la memoria relacionada, el target original (ops no-`add`) y
`expires_at = now() + QUARANTINE_RETENTION_DAYS`. Ante una credencial solo se reemplazan los tramos del
secreto por `[REDACTADO]` (el resto del texto se conserva); ante cualquier duda (tramo no localizable,
secreto en una clave de `fields`, recorte que partiría el centinela, re-chequeo fallido) se redacta el campo
o el ítem completo. Una clave privada PEM detectada en cualquier campo (o en `fields`) redacta siempre el
ítem completo: solo el encabezado es detectable y el cuerpo de la clave podría estar en otro campo. El rechazo
de segunda capa del juez (`security_second_layer`) se guarda siempre completo como `[REDACTADO]`.

Al redactar (`spans` o `whole`) también se reemplaza el `content_hash` del `staging_item`: pasa a ser
`sha256(<item id>:<hash del contenido redactado>)`. Así no queda el hash del contenido con el secreto, y dos
ítems redactados al mismo texto (por ejemplo dos `[REDACTADO]` completos) no chocan con
`UNIQUE(session_id, content_hash)`. Con redacción `none` el hash no cambia.

Acceso: el `project_admin` ve todas las entradas del proyecto; cualquier otro miembro ve solo las que creó
(`author_identity` = su subject) y, en el detalle, solo `reasonCode`/`criterion` (el `judgeReason` del juez es
solo para el admin). Restaurar es solo para `project_admin`. Todo lo demás recibe el mismo 404.

No se pueden restaurar entradas con contenido redactado: `reason_code` `secret_detected` o `sanitize_failed`,
o título/resumen/cuerpo igual a `[REDACTADO]` (404, y `canRestore=false` en el detalle). Las ramas `restore/` y
`web/` están reservadas: `remember` con `X-Git-Branch` en esos prefijos responde `INVALID_REFERENCE` y nunca
abre sesión; si igual hubiera una sesión abierta en `restore/<id>`, restaurar responde 404 (nunca 500).
Una entrada restaurada o vencida deja de verse en la API aunque el purge todavía no haya corrido.

```bash
P=00000000-0000-0000-0000-000000000010
curl -sS "http://localhost:3000/api/v1/projects/$P/quarantine?reason=secret_detected" -H 'X-Dev-User: tl@demo.local'
curl -sS http://localhost:3000/api/v1/projects/$P/quarantine/<id> -H 'X-Dev-User: tl@demo.local'
# restaurar: crea un item en la sesión restore/<id> (autor original) y corre el MISMO pipeline + juez
curl -sS -X POST http://localhost:3000/api/v1/projects/$P/quarantine/<id>/restore \
  -H 'X-Dev-User: tl@demo.local' -H 'Content-Type: application/json' -d '{}'
# → {"outcome":"applied","memoryId":...} | {"outcome":"queued","itemId":...} | {"outcome":"quarantined","quarantineId":<nueva>}
```

Restaurar una entrada ya restaurada da 404. Si el pipeline falla después de reclamar la entrada, el item
queda `pending` en su sesión `restore/<id>` y el error se loguea con ambos ids (un reintento da 404). Riesgo
residual documentado: no hay "des-reclamo" compensatorio; la entrada queda etiquetada como restaurada.

**Medición del juez.** `restored_at IS NOT NULL` marca un candidato a falso positivo; el resultado de la
restauración se obtiene uniendo `restored_item_id` con `staging_item` (`promoted_at`, `judge_state`):

```sql
SELECT criterion, reason_code, count(*) AS total,
       count(*) FILTER (WHERE restored_at IS NOT NULL) AS restored
FROM quarantine WHERE project_id = $1 GROUP BY 1, 2;
```

La etiqueta vive lo que vive la fila (la retención es la ventana de medición).

**Backfill de 0008.** Las entradas previas se clasifican con la misma tabla que el código y reciben
`expires_at = quarantined_at + 60 días`; las que ya tenían más de 60 días quedan purgables en la primera
corrida del job.

### Jobs internos (`/internal/jobs`)

`POST /internal/jobs/quarantine-purge` borra las entradas con `expires_at < now()` y responde
`{"job":"quarantine-purge","count":N,"detail":{"<projectId>":n}}` (queda auditado en `access_log` como
`system`/`admin`, solo conteos). Con `JOBS_TOKEN` (≥32 caracteres, comparado en tiempo constante) el router
está habilitado en cualquier entorno y el token se exige siempre. Sin token (modo abierto) solo se habilita
con `NODE_ENV=development` explícito: `production`, `test` o `NODE_ENV` sin definir lo dejan deshabilitado
(composición y router, `isJobsEnabled`/`isOpenMode`). Cualquier rechazo (deshabilitado, token ausente o
incorrecto, job desconocido, otro método) es el mismo 404; un token rechazado deja un `warn` en el log (sin el
token). Límite fijo de 10 requests/minuto por cliente (429 opaco).

```bash
# dev, sin JOBS_TOKEN (modo abierto)
curl -sS -X POST http://localhost:3000/internal/jobs/quarantine-purge
# con token
curl -sS -X POST http://localhost:3000/internal/jobs/quarantine-purge -H "Authorization: Bearer $JOBS_TOKEN"
# script (mismo servicio, audit trigger=script)
DATABASE_URL=postgres://gmemo:gmemo@localhost:5433/gmemo pnpm job:quarantine-purge
```

**Producción (documentado, no implementado): EventBridge Scheduler.** Un schedule diario con target
*API destination* `POST https://<host>/internal/jobs/quarantine-purge`, cuya *connection* guarda el bearer
`JOBS_TOKEN` en Secrets Manager (auth tipo API key, header `Authorization: Bearer <token>`). La imagen de
Fargate no incluye tsx, por eso el camino de producción es el HTTP y no el script.

### Web estática en dev

Con `WEB_STATIC_DIR=<carpeta del build>` (por ejemplo `packages/web/dist`) Express sirve la web en `/`, con
fallback SPA para rutas sin extensión. El fallback nunca intercepta `/api`, `/mcp`, `/promote`, `/internal` ni `/health`.
Las respuestas HTML llevan una CSP estricta same-origin y `Cache-Control: no-cache`; las respuestas JSON
no cambian. El server no arranca si la carpeta no tiene `index.html`. La variable está prohibida con
`NODE_ENV=production` (la config falla al arrancar).

### Producción: S3 + CloudFront

En producción Express no sirve la web. El build se sube a un bucket S3 privado detrás de CloudFront, con un
comportamiento `/api/*` que reenvía al ALB, así la web y la API quedan en el mismo origen (sin CORS ni
cookies, por lo que CSRF no aplica). La misma CSP se configura como response-headers policy de CloudFront.
