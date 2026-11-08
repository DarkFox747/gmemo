# Reporte de la Entrega 4 — Demo del prototipo gmemo

> Insumo para el título "Demo" del documento del TFG (Diego Soler, Licenciatura en Informática, Universidad Siglo 21).
> Rama `demo/e4` · fecha 2026-11-08.

## 1. Resumen de lo construido

**gmemo** es una plataforma de memoria compartida y gobernada para agentes de desarrollo de software.

**Procesos core implementados de punta a punta:**
- **Captura y promoción:** los agentes proponen unidades de conocimiento por MCP (`remember`) en un área de preparación por proyecto, repositorio y rama. Al integrarse el PR, la promoción pasa cada unidad por un pipeline de validación: credenciales, instrucciones embebidas y enmascarado de datos personales. Después la evalúa un **juez**, que registra veredicto, criterio, confianza y justificación.
- **Gobierno humano:**
  - las unidades se integran solas, quedan en la **cola de revisión humana** o van a **cuarentena** con redacción por tramos;
  - el líder técnico resuelve la cola desde una **web en español**, restaura o depura la cuarentena, revalida las memorias vencidas y gestiona la memoria del proyecto directamente;
  - las escrituras directas pasan por el mismo pipeline y la misma ruta de escritura que la promoción.
- **Búsqueda:** `recall` combina búsqueda léxica (BM25 con decaimiento temporal) y semántica (pgvector) con **fusión por rango recíproco**, y devuelve solo conocimiento activo.

**Cómo corre la demo:** en local con `docker compose up --build`, sin cuenta de AWS. Usa stubs deterministas del juez, el embedder, OIDC y Cognito, protegidos para que sea imposible activarlos en producción. Incluye un guion E2E (`pnpm demo`), métricas sintéticas (`pnpm eval`), un instructivo y un paquete sanitizado.

## 2. HU / TT → estado

| HU / TT | Estado | Implementación (archivo · endpoint · tool · pantalla) | Tests principales |
|---|---|---|---|
| HU-03 Captura (1–5) | Completa | tool MCP `remember`/`list_staged`/`discard_staged` · `src/mcp/tools/*` | `tests/staging/*` |
| HU-04.1/.3 Promoción e idempotencia | Completa | `POST /promote` (sesión de la rama del PR mergeado, con `pr_number`; o de la rama por defecto) · `.github/workflows/promote.yml` · `src/promote/promoteService.ts` | `tests/promote/*`, `tests/http/promote.test.ts`, `tests/db/promotion.integration.test.ts` |
| HU-04.2 PR cerrado sin integrar | Completa | `POST /promote` `event: closed_unmerged` · `.github/workflows/promote.yml` | `tests/http/promote.test.ts` |
| HU-05 Validación (formato, credenciales, instrucciones, datos personales) | Completa | `src/promote/sanitize.ts`, `src/security/{secretScan,injectionScan,piiMask,secretRedact}.ts` | `tests/promote/sanitize.test.ts`, `tests/security/*` |
| HU-06 Juez (1–6, Tabla 3) | Completa | `src/judge/*`, `src/promote/routing.ts` | `tests/promote/promoteVerdict.test.ts`, `tests/judge/*` |
| HU-07 Revisión humana (1–5) | Completa | `/api/v1/projects/:id/review-queue[/:itemId[/approve\|/reject]]` · pantallas Cola y Detalle | `tests/http/api/reviewQueue.test.ts`, `tests/db/review*.integration.test.ts` |
| HU-08 Búsqueda híbrida (1–5) | Completa | tool `recall` · `src/search/rrf.ts` | `tests/mcp/recallRrf.test.ts`, `tests/search/rrf.test.ts` |
| HU-09 Contexto inicial | Completa | tool `get_context` (solo activas) | `tests/memory/*`, `tests/db/statusExclusion.integration.test.ts` |
| HU-10 Cuarentena (1–4) | Completa | `/api/v1/projects/:id/quarantine[/:id[/restore]]` · `/internal/jobs/quarantine-purge` · pantalla Cuarentena | `tests/db/{restore,secretNeverPersisted,quarantineRepository}.integration.test.ts` |
| HU-11.1/.2 Corrección y reemplazo | Completa | aplicación de las 4 operaciones · `applyOpInTxn` | `tests/db/promotion.integration.test.ts` |
| HU-11.3 Revisión desactualizada → revisión humana | Completa | `stale_target` + `mandatory_review` | `tests/promote/promoteVerdict.test.ts`, `tests/staging/remember.test.ts` |
| HU-11.4 Retiro en bloque por PR | Completa | `POST /api/v1/projects/:id/memories/retire-by-pr` · pantalla Memoria | `tests/db/lifecycle.integration.test.ts` |
| HU-12 Revalidación (1–4) | Completa | `/internal/jobs/revalidation-sweep`, `confirm`, `retire` · pestaña Pendientes | `tests/db/lifecycle*.test.ts`, `tests/jobs/revalidationJob.test.ts` |
| HU-13 Gestión directa (1–5) | Completa | `/api/v1/projects/:id/memories` (list, detail, preview, POST, PUT) · pantalla Memoria del proyecto | `tests/db/directMemory.integration.test.ts`, `tests/http/api/directMemory.test.ts` |
| Permisos (Tabla 44) | Completa | `authorizeProjectAdmin` / `authorizeProjectMember`, 404 uniforme | `tests/http/api/*permissions*.test.ts`, `tests/auth/*` |
| TT-06 Métricas | Completa (sintéticas) | `pnpm eval` → `docs/demo/metricas.md` | `tests/eval/metrics.test.ts` |
| TT-08 Web de gobierno | Completa | `packages/web` (5 pantallas, Figuras 12–16) | `packages/web/src/**/*.test.ts` + recorridos Playwright |

## 3. Divergencias con el documento

**Resueltas** (sección 3 del plan):
1. Búsqueda: fusión RRF con k = 5 por defecto y hasta 8, en lugar de dos fases (C6).
2. Juez: veredicto, criterio, confianza y justificación, con umbral y revisión obligatoria (C1).
3. Estados: `pending_revalidation` y `revalidate_at` (C4).
4. Modificación concurrente: va a revisión humana, no a cuarentena (C1).
5. Cuarentena: redacción por tramos, criterio y motivo, restauración y vencimiento a 60 días (C3).
6. Nombre: el producto pasa de LPMS a gmemo (C0). Se conserva "LPMS" solo como predecesor local o herramienta del orquestador.
7. Promoción de la rama del PR (HU-04.1, change `feature-branch-promotion`): el merge promueve la sesión de la rama de feature y registra rama y PR de origen. El workflow `promote.yml` resuelve el PR a partir del commit del merge y envía `source_branch` + `pr_number`; `/promote` exige un token emitido por el push de `promote.yml` en la rama por defecto (se validan `ref`, `event_name` y `job_workflow_ref`) y `pr_number` cuando la rama no es la por defecto. El servidor no vuelve a verificar el PR contra la API de GitHub (fuera de alcance): el límite de confianza es el workflow de la rama por defecto, que solo ejecuta código revisado.

**Que quedan, con su justificación:**
- **La web usa el login de desarrollo** (`X-Dev-User`). El login real con Cognito y PKCE está fuera de alcance.
- **Notificaciones como log estructurado** (`review_enqueued`, `leak_detected`), sin SES.
- **El juez determinista de la demo es heurístico.** La calidad semántica real requiere Bedrock (el cliente existe y está protegido).

## 4. Simplificaciones respecto de la arquitectura AWS

- La promoción corre en proceso, sin SQS ni worker separado.
- Los jobs (`quarantine-purge`, `revalidation-sweep`, `web-session-reaper`) se ejecutan por endpoint interno o script, sin EventBridge Scheduler.
- La web la sirve Express en desarrollo, en lugar de S3 + CloudFront.
- Notificaciones por log, sin SES.
- Sin WAF ni el hardening del backlog `infra-hardening`.
- Juez, embedder, OIDC de GitHub y Cognito en modo stub.
- No hay ABM de proyectos, repos, miembros ni credenciales: la administración es de solo lectura y el alta sigue siendo por script `provision`.
- No hay memoria estructural (Layer 2), ni integración con tickets, ni migración de memorias locales.
- El piloto de Terraform existe, pero la demo es local.

## 5. Números

| Métrica | Valor |
|---|---|
| Tests totales (suite con DB) | **1973** (0 fallas) |
| Tests unitarios (sin DB) | 1684 |
| Tests de integración con DB | 289 |
| Migraciones SQL | 10 (`0001`–`0010`) |
| Tools MCP | 6 (`recall`, `get_memory`, `get_context`, `remember`, `list_staged`, `discard_staged`) |
| Endpoints REST `/api/v1` | 17 |
| Otros endpoints | `POST /promote`, `GET /health`, `POST /internal/jobs/:job` (3 jobs) |
| Pantallas web | 5 (Cola de revisión, Detalle, Cuarentena, Memoria del proyecto, Administración) + vistas de detalle y formulario |
| Smoke (`pnpm smoke`) | 20 pasos |
| Guion E2E (`pnpm demo`) | 35 verificaciones |

**Métricas sintéticas** (`pnpm eval`, datos sintéticos, juez y embedder stub):

| Método | recall@5 | MRR | nDCG@5 |
|---|---|---|---|
| Híbrido RRF (embedder stub) | 0,911 | 0,694 | 0,695 |
| Solo léxico (referencia) | 0,878 | 1,000 | 0,954 |

Juez determinista: tasa de falsos positivos 0,300 (3/10) y de falsos negativos 0,200 (2/10).

**Lectura de los resultados.** El embedder stub no tiene semántica, así que el componente vectorial agrega ruido al orden. Por eso RRF mejora la cobertura (recall@5) pero baja el MRR y el nDCG frente al léxico puro. Con el embedder real (Titan v2) se espera revertir ese efecto. Es una limitación declarada de la demo.

## 6. Cómo correr la demo

Ver **[`docs/demo/INSTRUCTIVO.md`](INSTRUCTIVO.md)**. El resumen:
1. `docker compose up --build`.
2. Abrir http://localhost:3000/, elegir el usuario "Líder técnico" y recorrer las 5 pantallas. Las capturas están en [`docs/demo/capturas/`](capturas/).
3. `pnpm demo` (requiere Node 22 y pnpm 9) para el ciclo E2E guiado.
4. Opcional: conectar un agente real con [`docs/demo/mcp-local.example.json`](mcp-local.example.json).

## 7. Comandos `pnpm add` pendientes

Ninguno: las dependencias de la web y Playwright ya se agregaron (commit `7b73fb8`).

**Pendientes del dueño del repo (fuera de banda):**
- `.env.dev.example`: actualizar a las credenciales `gmemo`, el puerto **5433**, `EMBEDDER_STUB=true`, el remote `crombie-llc/gmemo-demo`, y quitar `JUDGE_STUB_VERDICT`. Los agentes no pueden editar archivos `.env*`.
- `.env.example`: tiene una edición local accidental; revertir con `git checkout -- .env.example`.
- Revisar a mano los PNG de `docs/artefactos/` por si tienen identificadores embebidos.
- Antes de cualquier deploy: renombrar en GitHub las variables `LPMS_*` a `GMEMO_*` y apuntar `AWS_ROLE_ARN` al rol renombrado.
- Opcional: contexto de área para `packages/web`. El contenido está preparado; escribirlo bajo `.claude/` fue rechazado por el sistema de permisos como auto-modificación.

## 8. Changes archivados

| Change | Commit | Verify |
|---|---|---|
| Línea base sanitizada | `8359c10` | — |
| C0 `demo-baseline` | `c5090e1` | PASS |
| C1 `judge-structured-verdict` | `aca6e80` | PASS (2 rondas) |
| C2 `web-api-and-review-queue` | `cb6110f` | PASS (2 rondas) |
| C3 `quarantine-management` | `cd3c3d9` | PASS (2 rondas) |
| C4 `memory-lifecycle` | `2baf861` | PASS |
| C6 `hybrid-search-rrf` | `ff0b8b3` | PASS (2 rondas) |
| C5 `direct-memory-management` | `c4968ce` | PASS (2 rondas) |
| Dependencias web aprobadas | `7b73fb8` | — |
| C8 `demo-kit` | `85f65c4`, `aae5ba4` | PASS (2 rondas) |
| C7 `governance-web` | `bbd5417` | PASS |
| C9 `feature-branch-promotion` | `5769291` | PASS (2 rondas) |

Los reportes completos (propuesta, specs, design, tasks, apply-progress, verify y archive) están en `openspec/changes/archive/`. Las specs vigentes están en `openspec/specs/`.
