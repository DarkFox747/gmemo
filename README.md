# gmemo — Memoria compartida y gobernada para agentes de desarrollo

**gmemo** es la *Plataforma de Memoria Compartida y Gobernada para Agentes de Desarrollo de Software*, Trabajo Final de Grado de la Universidad Siglo 21. Es la evolución de LPMS (memoria local por dev) a un servicio de memoria compartida para equipos de desarrollo: los agentes de IA recuerdan decisiones, restricciones y reglas del proyecto, pero solo **proponen** conocimiento nuevo; nada llega a la memoria principal sin pasar por validación automática y, cuando corresponde, por una persona.

## Funcionalidades

- **Fachada MCP**: `recall`, `remember`, `get_memory`, `get_context`, `list_staged` y `discard_staged` sobre `POST /mcp`.
- **Staging**: los agentes escriben a una sesión de preparación, nunca a la memoria principal.
- **Pipeline de promoción + juez**: `POST /promote` sanea y evalúa cada propuesta con un juez (Bedrock, o determinista en desarrollo).
- **Cola de revisión humana**: lo dudoso y los tipos obligatorios (`MANDATORY_REVIEW_TYPES`) esperan la decisión de un administrador.
- **Cuarentena**: lo rechazado por seguridad se retiene con vencimiento y se puede restaurar.
- **Ciclo de vida**: revalidación periódica, retiro y reversión de memorias.
- **Gestión directa**: alta, edición y retiro de memorias por un administrador, con historial de revisiones.
- **Búsqueda híbrida RRF**: texto completo + vectores (pgvector) fusionados con Reciprocal Rank Fusion; misma función compartida entre `recall` y el explorador web.
- **Web de gobierno (9 pantallas)**: Inicio con métricas en vivo del juez, cola de revisión, detalle, área de preparación, memoria del proyecto con historial de revisiones, buscar como agente, cuarentena, actividad y administración.
- **Auditoría trazable**: toda escritura REST registra su fila de `access_log` en la misma transacción; pantalla Actividad visible para el líder técnico.

## Inicio rápido

```bash
docker compose up --build
pnpm demo
```

Luego abrir **http://localhost:3000/** (entra en Inicio; el selector *Usuario de desarrollo* elige `tl@`, `dev@` o `viewer@demo.local`). `pnpm demo` recorre el flujo completo contra el stack local. Requiere Docker; Node 22 y pnpm solo para los scripts del host.

| Script demo | Qué hace |
|---|---|
| `pnpm demo` | ciclo E2E guiado (remember → promote → recall) |
| `pnpm demo:promote -- --branch <rama> --pr <n>` | simula el merge de un PR de agente desde local |
| `pnpm demo:reset` | `docker compose down -v && up --build` — borra todo y vuelve al seed limpio |
| `pnpm screenshots` | genera las capturas de `docs/demo/capturas/` sobre el stack levantado |

> **Los bypass/stubs son solo de dev.** `AUTH_DEV_BYPASS`, `JUDGE_STUB`, `PROMOTE_OIDC_DEV_BYPASS` y
> `EMBEDDER_STUB` con `NODE_ENV=production` (y `RATE_LIMIT_ENABLED=false`) hacen que la config se
> rechace: el server sale con código 1 al arrancar.

## Documentación

- [`docs/demo/INSTRUCTIVO.md`](docs/demo/INSTRUCTIVO.md): instructivo de la demo, paso a paso.
- [`DEVELOPMENT.md`](DEVELOPMENT.md): desarrollo, scripts, tests y ejemplos de API.
- [`docs/demo/metricas.md`](docs/demo/metricas.md): métricas del proyecto.
- [`docs/demo/capturas/`](docs/demo/capturas/): capturas de la web de gobierno.
- [`openspec/`](openspec/): especificaciones y changes SDD (incluye `backlog.md`).
- [`packages/web/README.md`](packages/web/README.md): web de gobierno.

## Integración continua

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) corre en cada pull request y en cada push a `main` el mismo chequeo completo que se usa en local: instalación con `--frozen-lockfile`, `pnpm lint`, `pnpm build`, `pnpm typecheck:web`, `pnpm build:web` y la suite completa (`pnpm exec vitest run`, unitarios + integración) contra un Postgres `pgvector/pgvector:pg16` efímero. Acciones fijadas por SHA y permisos de solo lectura.

## Gestor de paquetes: SOLO pnpm

Este repo usa **pnpm exclusivamente** (versión fijada en `package.json`, campo `packageManager`); npm, yarn y bun están bloqueados.

## Configuración

Variables de entorno (`src/config/index.ts`):

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

## Índice de diseño

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
