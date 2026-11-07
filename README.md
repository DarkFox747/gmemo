# LPMS Cloud — Memoria global del diseño

Notas de trabajo del diseño de **LPMS Cloud**, la evolución de LPMS (memoria local por dev)
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

285 tests en verde (49 de integración DB se saltean sin `DATABASE_URL`) · gestor de paquetes **pnpm** exclusivo.
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

## Cómo correr el servicio (pilot scaffold)

Slice mínimo del servicio: Express + MCP facade con los tools de lectura (`recall`,
`get_memory`, `get_context`) como stubs tipados. Sin DB ni auth todavía (changes B/C).

```bash
pnpm install        # instalar dependencias
pnpm dev            # arrancar en watch (tsx) — expone GET /health y POST /mcp
pnpm test           # correr la suite de Vitest
pnpm build          # compilar TypeScript a dist/
pnpm start          # correr el build (node dist/index.js)
pnpm lint           # ESLint (flat config)
```

Variables de entorno en `.env.example` (`PORT`, `HOST`, `NODE_ENV`, `LOG_LEVEL`).
`GET /health` responde `{ "status": "ok" }`.

## Levantar en 2 comandos (Local Dev — Docker)

```bash
cp .env.dev.example .env
docker compose up --build
```

Compose starts postgres:16, runs numbered migrations + the dev seed (one-shot `migrate`
service), then starts the app. When ready:

```
GET http://localhost:3000/health
→ 200  { "status": "ok" }
```

Gate 1 (Cognito) is STUBBED by `DevAuthenticator` (`AUTH_DEV_BYPASS=true`); Gate 2,
RBAC, and audit run for real against the seeded local DB. Every request to `POST /mcp`
must carry the seeded git remote header; no `Authorization` header is needed locally.

> **Dev bypass is local-only.** The config `superRefine` refuses to load when
> `AUTH_DEV_BYPASS=true` AND `NODE_ENV=production` — the server exits 1 at boot.

### Sample POST /mcp — recall (JSON-RPC tools/call)

```bash
curl -sS http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-Git-Remote: https://github.com/crombie-dev/lpms-cloud.git' \
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
  -H 'X-Git-Remote: https://github.com/crombie-dev/lpms-cloud.git' \
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
