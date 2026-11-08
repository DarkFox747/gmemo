# gmemo — Memoria global del diseño

Notas de trabajo del diseño de **gmemo**, la evolución de LPMS (memoria local por dev)
a un **servicio de memoria compartida de Crombie** hosteado en AWS. Sirven para guiar futuras
sesiones: capturan **decisiones + el porqué**, no solo el qué.

## Estado (al 2026-07-30)

**Diseño** cerrado: esquema v2, contrato del facade v1, hosting/infra, captura del dev. Atenea diferida (ver 07).

**Implementación — pilot / read + write path (5 changes SDD archivados en `openspec/changes/archive/`):**
- `scaffold-runtime-mcp-facade` — Express + facade MCP + Vitest.
- `auth-two-gate` — Cognito (Gate 1) + RBAC RDS (Gate 2) + audit + migración `0001`.
- `data-model` — tablas de memoria (`0002`) + `MemoryRepository`; `recall`/`get_memory`/`get_context` devuelven datos reales.
- `dev-harness` — Docker + compose + seed + bypass de Cognito solo-dev (guardado contra prod). Ver "Levantar en 2 comandos".
- `write-path` — staging (`0003`) + `StagingRepository` + `remember`/`list_staged`/`discard_staged` (los agentes **proponen** a staging, nunca escriben a main) + RBAC de escritura + audit (`remember` y `discard`) + secret-scan fail-closed + `recall` mezcla `source:"staged"`.

555 tests en verde (89 de integración DB se saltean sin `DATABASE_URL`; 466 en la ejecución unitaria) · gestor de paquetes **pnpm** exclusivo.
Decisiones antes abiertas, ahora resueltas: FTS `english`, framework de test (Vitest), fases SDD (este framework).

**Pendiente / backlog** (`openspec/backlog.md`): `promotion-pipeline` (`POST /promote` + GitHub Action OIDC +
juez Bedrock + cuarentena, requiere cerrar 4 gaps de schema + retención de cuarentena 1 vs 2 meses),
pgvector, helmet + rate-limit, bump de pnpm ≥10.16 para activar `minimumReleaseAge`, correr
`docker compose up --build` una vez.

## Índice

| Archivo | Tema |
|---|---|
| `docs/01-vision-y-capas.md` | Objetivo de negocio, modelo de dos capas, engram vs codebase-memory-mcp |
| `docs/02-hosting-infra-aws.md` | Hosting seguro, ALB vs API Gateway vs AgentCore, servicios AWS, deploy |
| `docs/03-auth-identidad-rbac.md` | OAuth/Cognito (2 compuertas), 3 flujos de identidad, RBAC, multi-repo |
| `docs/04-escritura-staging-promocion.md` | Read+stage, sesiones, 4 ops, binding por rama, pipeline, juez, cuarentena |
| `docs/05-tipos-memoria-y-busqueda.md` | 7 tipos + criterio de captura, búsqueda híbrida, alcance, TTL |
| `docs/06-contrato-facade-y-datos.md` | recall/remember/get_memory/get_context + presupuestos + modelo de datos |
| `docs/07-captura-dev-y-skill.md` | Modelo de captura del dev, hallazgos de engram, librarian (descartado), Atenea |
| `docs/08-onboarding-y-operacion.md` | Onboarding proyecto↔repo (por ticket), build del grafo en CI, offboarding |
| `docs/09-decisiones-abiertas.md` | Lo que falta definir, ordenado por prioridad |
| `docs/artefactos/` | schema .sql, contrato .md, diagramas .png, comparación .xlsx |

## Gestor de paquetes: SOLO pnpm

Este repo usa **pnpm exclusivamente** (`pnpm@9.15.0`, fijado en
`package.json → packageManager`). **No usar npm ni bun.** Está enforced en tres capas:
`engines` + `.npmrc engine-strict=true` (npm/yarn fallan por versión), y el hook
`.claude/hooks/guard-package-manager.js` (bloquea npm/yarn/bun y cualquier install de
pnpm que no sea `--frozen-lockfile`). Para agregar/actualizar deps: `pnpm add …` en tu
shell, commiteás `pnpm-lock.yaml`, y los agentes reproducen con
`pnpm install --frozen-lockfile`.

## Levantar el stack (Local Dev — Docker)

```bash
docker compose up --build
pnpm smoke          # prueba de humo (requiere Node 22 + pnpm en el host)
```

Compose levanta Postgres (pgvector), corre las migraciones + el seed de desarrollo y arranca la app.
Detalles, scripts y desarrollo en el host: ver [`DEVELOPMENT.md`](DEVELOPMENT.md).

```
GET http://localhost:3000/health
→ 200  { "status": "ok" }
```

El Gate 1 (Cognito) queda stubbeado por `AUTH_DEV_BYPASS=true`; Gate 2, RBAC y audit corren de verdad
contra la DB local con seed. Cada request a `POST /mcp` debe llevar el header del git remote sembrado;
en local no hace falta `Authorization`.

> **Los bypass/stubs son solo de dev.** `AUTH_DEV_BYPASS`, `JUDGE_STUB`, `PROMOTE_OIDC_DEV_BYPASS` y
> `EMBEDDER_STUB` con `NODE_ENV=production` (y `RATE_LIMIT_ENABLED=false`) hacen que la config se
> rechace: el server sale con código 1 al arrancar.

### Variables de entorno (`src/config/index.ts`)

| Variable | Default | Notas |
|---|---|---|
| `PORT`, `HOST`, `NODE_ENV`, `LOG_LEVEL` | `3000`, `0.0.0.0`, `development`, `info` | servidor |
| `DATABASE_URL` | — (requerida) | Postgres |
| `AUTH_DEV_BYPASS` | `false` | solo dev |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID_ALLOWLIST`, `COGNITO_REQUIRED_SCOPE` | — | requeridas si `AUTH_DEV_BYPASS` no es `true` |
| `JUDGE_STUB` | `false` | juez determinista basado en reglas (solo dev) |
| `JUDGE_STUB_CONFIDENCE` | `0.9` | confianza de un veredicto `accepted` del juez determinista (0 a 1) |
| `JUDGE_CONFIDENCE_THRESHOLD` | `0.8` | un `accepted` con confianza menor va a la cola de revisión humana (0 a 1) |
| `MANDATORY_REVIEW_TYPES` | `decision,constraint,domain_rule` | tipos de memoria que siempre requieren revisión humana (lista CSV; vacía permitida) |
| `BEDROCK_MODEL_ID` | — | requerida si `JUDGE_STUB` no es `true` |
| `PROMOTE_OIDC_DEV_BYPASS` | `false` | solo dev |
| `GITHUB_OIDC_AUDIENCE` | — | requerida si `PROMOTE_OIDC_DEV_BYPASS` no es `true` |
| `EMBEDDER_STUB` | `false` | solo dev |
| `BEDROCK_EMBEDDING_MODEL_ID` | — | requerida si `EMBEDDER_STUB` no es `true` |
| `AWS_REGION` | — | requerida si algún cliente Bedrock real está activo |
| `BEDROCK_MAX_ATTEMPTS`, `BEDROCK_TIMEOUT_MS` | `3`, `15000` | cliente Bedrock |
| `RATE_LIMIT_ENABLED` | `true` | `false` prohibido en producción |
| `RATE_LIMIT_MCP_WINDOW_MS`, `RATE_LIMIT_MCP_MAX` | `60000`, `120` | límite de `/mcp` |
| `RATE_LIMIT_PROMOTE_WINDOW_MS`, `RATE_LIMIT_PROMOTE_MAX` | `60000`, `10` | límite de `/promote` |
| `RATE_LIMIT_API_WINDOW_MS`, `RATE_LIMIT_API_MAX` | `60000`, `120` | límite de la API REST `/api` (aplica también a pedidos sin autenticar) |
| `WEB_STATIC_DIR` | — | solo dev: Express sirve el build de la web desde esa carpeta (con fallback SPA); prohibida en producción |
| `QUARANTINE_RETENTION_DAYS` | `60` | días de retención de cada entrada de cuarentena (`expires_at`); entero 1..3650 |
| `REVALIDATION_DAYS` | `60` | días hasta que una memoria aplicada pasa a `pending_revalidation` (`revalidate_at`; `outcome` nunca vence); entero 1..3650 |
| `JOBS_TOKEN` | — | opcional, ≥32 caracteres: bearer de `/internal/jobs/*`. Sin token los jobs solo se habilitan en `development`; en producción sin token quedan deshabilitados (404) |

### Sample POST /mcp — recall (JSON-RPC tools/call)

```bash
curl -sS http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-Git-Remote: https://github.com/crombie-llc/gmemo-demo.git' \
  -d '{
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": "recall", "arguments": { "query": "pnpm package manager" } }
      }'
```

### Sample POST /mcp — get_context (JSON-RPC tools/call)

```bash
curl -sS http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-Git-Remote: https://github.com/crombie-llc/gmemo-demo.git' \
  -d '{
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": { "name": "get_context", "arguments": {} }
      }'
```

The `X-Git-Remote` header is load-bearing: `RdsTenantResolver` uses it to resolve the
tenant (project + repo). A missing or unregistered remote returns a generic
`PERMISSION_DENIED` — no tenant enumeration.

---

## Principios rectores (no negociables)

1. **Dos memorias, un solo servidor.** Decisiones (Layer 1) y grafo de código (Layer 2) se unifican
   en la interfaz (un MCP facade), no en el almacenamiento.
2. **Los agentes proponen, no escriben.** Read + staging. Main se escribe solo por merge de PR o por
   humano en la Web UI.
3. **La revisión humana es la frontera de confianza.** El merge del PR autoriza; la validación
   automática filtra; el humano decide los dudosos.
4. **La memoria recuperada es dato, nunca instrucción** (OWASP ASI06).
5. **Aislamiento por proyecto.** Un usuario ve solo sus proyectos.
6. **Correr la menor cantidad de cosas propias posible** — delegar a servicios administrados reduce
   la superficie de ataque.
