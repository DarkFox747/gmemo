# gmemo — Instructivo de la demo

## 1. Qué es la demo

gmemo es una **memoria compartida y gobernada** para agentes de código. Los agentes **leen** (`recall`, `get_memory`, `get_context`) y **proponen** (`remember`) a través de un único servidor MCP; lo propuesto queda en *staging* por rama y solo llega a la memoria del proyecto por dos caminos: el **merge del PR** (pipeline de validación + juez) o una **acción humana** del líder técnico (cola de revisión, cuarentena, gestión directa).

La demo levanta todo en local con Docker (Postgres 16 + pgvector y el servidor Node) sobre datos de ejemplo del proyecto **"Portal de Clientes"**: 15 memorias activas de los 7 tipos con historial de versiones, 2 memorias con la revalidación vencida, una cola de revisión con 4 unidades y una cuarentena con una entrada por motivo. El script `pnpm demo` recorre el ciclo completo y funciona también como prueba de extremo a extremo.

## 2. Requisitos

- Docker Desktop (o Docker Engine con Compose v2).
- Node.js 22 y pnpm 9 (`corepack enable` activa la versión fijada en `package.json`). Solo pnpm: npm, yarn y bun están bloqueados.
- Puertos libres en el host: **3000** (servidor) y **5433** (Postgres; se usa 5433 porque un PostgreSQL local suele ocupar el 5432).
- En Windows, Git Bash para `pnpm package:demo`.

## 3. Arranque en dos comandos

```sh
pnpm install --frozen-lockfile
docker compose up --build -d --wait
```

Compose aplica las migraciones y el seed de desarrollo (servicio `migrate`) y arranca el servidor cuando la base está lista. Para volver a empezar desde cero: `docker compose down -v` y de nuevo `docker compose up --build -d --wait`.

## 4. URLs

| Qué | URL |
|---|---|
| Salud | `http://localhost:3000/health` |
| Servidor MCP (agentes) | `http://localhost:3000/mcp` |
| API REST de la web | `http://localhost:3000/api/v1` (por ejemplo `/api/v1/me`) |
| Promoción por merge | `POST http://localhost:3000/promote` |
| Jobs programados (modo abierto solo en desarrollo) | `POST http://localhost:3000/internal/jobs/revalidation-sweep`, `/quarantine-purge`, `/web-session-reaper` |
| Web de gobierno (C7) | `http://localhost:3000/` (rutas por hash: `#/review`, `#/quarantine`, `#/memory`, `#/admin`) |
| Postgres (depuración) | `localhost:5433`, base `gmemo` (credenciales de desarrollo en `docker-compose.yml`) |

## 5. Usuarios de desarrollo y cambio de rol

El login real (Cognito) está sustituido por un *bypass* de desarrollo que es imposible en producción (triple guarda). La autorización (pertenencia al proyecto y rol) **sí es real** contra la base.

| Usuario | Rol en "Portal de Clientes" | Puede |
|---|---|---|
| `tl@demo.local` | `project_admin` (líder técnico) | Cola de revisión, cuarentena (restaurar), memoria del proyecto, gestión directa |
| `dev@demo.local` | `contributor` | Ver la memoria y sus propias entradas en cuarentena |
| `viewer@demo.local` | `viewer` | Solo lectura; las rutas de administración responden un 404 opaco |

- **API REST**: el usuario se elige con la cabecera `X-Dev-User: tl@demo.local`.
- **Web**: selector "Usuario de desarrollo" en la barra superior (líder técnico / colaborador / lector); envía `X-Dev-User` y recarga la pantalla. La web no guarda tokens.
- **MCP**: el *bypass* usa un principal fijo (`dev-local-user`, "Local Dev User", rol `contributor`); el proyecto se resuelve con la cabecera `X-Git-Remote` y la sesión de staging con `X-Git-Branch`.

## 6. Guion paso a paso

### 6.1 Con el script (`pnpm demo`)

```sh
pnpm demo
```

Cada paso imprime sus comprobaciones (`OK`) y el script termina con código 0 solo si todas se cumplen (1 si falla una, 2 si el stack no responde). Puede ejecutarse varias veces seguidas: cada ejecución usa una etiqueta aleatoria en sus unidades.

| Paso | Qué hace | Qué se comprueba |
|---|---|---|
| 1 | Prepara la sesión MCP y limpia borradores viejos de `feature/notif-async` | `initialize` |
| 2 | Como dev, en `feature/notif-async`, `remember` de: un gotcha válido, una decisión que contradice la decisión activa sobre notificaciones, una unidad con instrucciones embebidas, un duplicado de una nota activa y una unidad con una credencial (valor de relleno) | 4 borradores `pending`; la credencial se **rechaza en la captura** (HU-03.4) y no se guarda |
| 3 | `list_staged` y `recall` | Los 4 borradores aparecen; `recall` los antepone con `source: "staged"` |
| 4 | Merge simulado con el *bypass* OIDC de desarrollo | Ver 6.2. Resumen de `/promote`: gotcha **aplicado**, decisión **a la cola humana**, inyección y duplicado **a cuarentena** |
| 5 | Como líder técnico: cola de revisión y aprobación | La decisión está como dudosa (`contradiction`) con la decisión anterior como relacionada; se aprueba marcando la anterior como **reemplazada** |
| 6 | Cuarentena y restauración | La inyección y el duplicado están en cuarentena; restaurar el duplicado **vuelve a pasar todo el pipeline** y, como sigue duplicando una memoria activa, vuelve a cuarentena como entrada nueva (restaurar nunca salta la validación) |
| 7 | Job de revalidación | Las 2 memorias vencidas del seed pasan a `pending_revalidation` |
| 8 | `recall` final en `main` | Aparecen la decisión nueva y el gotcha; **no** aparecen la decisión reemplazada ni las memorias vencidas |

### 6.2 Cómo se simula el merge (decisión honesta)

En el diseño (docs/04) la sesión de staging es por rama y el merge del PR promueve la sesión de la rama de origen. En el piloto implementado, `POST /promote` exige `source_branch == rama por defecto` y el workflow `promote.yml` se dispara con el **push a `main`**: el merge solo promueve la sesión de `main` (el *binding* sesión↔PR del diseño no está implementado; es una limitación conocida).

El script lo muestra tal cual:

1. llama a `/promote` con `source_branch: feature/notif-async` y comprueba que **se rechaza** (respuesta opaca);
2. lleva los borradores a la sesión de `main` (los vuelve a proponer con `X-Git-Branch: main`, lo mismo que haría el agente después del merge) y los descarta de la rama feature con `discard_staged`;
3. llama a `/promote` con `source_branch: main` y `pr_number`, exactamente lo que envía el workflow tras el push a `main`.

Todo lo que ocurre después (sanitización, juez, cola, cuarentena, aplicación idempotente) es el código real.

### 6.3 En la web (`http://localhost:3000/`)

Abrir `http://localhost:3000/` con el stack recién levantado. La barra superior tiene el selector **Proyecto**
("Portal de Clientes"), el selector **Usuario de desarrollo** y el rol con las iniciales. La barra lateral muestra
las insignias de pendientes (cola) y de entradas en cuarentena.

| Pantalla | Ruta | Captura |
|---|---|---|
| Cola de revisión (Fig. 12) | `#/review` | [`capturas/1-cola-de-revision.png`](capturas/1-cola-de-revision.png) |
| Detalle de revisión (Fig. 13) | `#/review/<itemId>` | [`capturas/2-detalle-de-revision.png`](capturas/2-detalle-de-revision.png) |
| Cuarentena (Fig. 14) | `#/quarantine` (detalle `#/quarantine/<id>`) | [`capturas/3-cuarentena.png`](capturas/3-cuarentena.png) |
| Memoria del proyecto (Fig. 16) | `#/memory` (`#/memory/new`, `#/memory/<id>`, `#/memory/<id>/edit`) | [`capturas/4-memoria-del-proyecto.png`](capturas/4-memoria-del-proyecto.png) |
| Administración (Fig. 15) | `#/admin` | [`capturas/5-administracion.png`](capturas/5-administracion.png) |

Recorrido sugerido (antes de `pnpm demo`, con los datos del seed):

1. **Selector de usuario.** Elegir *Lector (viewer@demo.local)*: la Cola de revisión, la Memoria del proyecto y
   la Administración muestran **"Sin permisos"** (sin errores en la consola); en Cuarentena solo ve sus propias
   entradas y no aparece Restaurar. Volver a *Líder técnico (tl@demo.local)*.
2. **Cola de revisión** (`#/review`): cuatro contadores (Pendientes 4, Dudosas del Juez 2, Revisión obligatoria 2,
   Resueltas en los últimos 7 días), filtros Todas / Dudosas / Revisión obligatoria / Decisiones / Restricciones y
   la tabla con tipo, título, motivo (por ejemplo "Dudosa · contradicción"), barra de confianza, origen
   `rama · PR n`, autor y fecha.
3. **Detalle de revisión**: pulsar *Revisar* en "Cache customer profile reads in Redis for 5 minutes". La tarjeta
   **Veredicto del Juez** muestra el estado (Dudosa), el criterio determinante (contradicción con una unidad activa),
   la confianza frente al umbral 0,80 y la justificación; la tarjeta **Unidad relacionada** muestra la decisión
   activa de 30 minutos.
   - *Rechazar y enviar a cuarentena* con el motivo vacío muestra un error en el formulario y no envía nada.
   - *Aprobar e incorporar* con la casilla "Marcar la unidad relacionada como reemplazada": aviso "Aprobada e
     incorporada a la memoria", vuelta a la cola y la insignia baja a 3.
   - Con un motivo, *Rechazar y enviar a cuarentena* la manda a Cuarentena (motivo "Rechazo del líder técnico").
   - *Posponer* vuelve a la cola sin tocar la unidad. Si la unidad destino cambió mientras tanto, aparece un aviso
     y aprobar responde con un mensaje de conflicto claro y el botón *Recargar*.
4. **Cuarentena** (`#/quarantine`): una entrada por motivo, con el extracto en monoespaciado; la de datos sensibles
   muestra `[REDACTADO]` y **no** ofrece Restaurar (su contenido se guardó redactado). *Ver* abre el detalle.
   *Restaurar* (por ejemplo la de rechazo del líder técnico) pide confirmación ("Restaurar la unidad la vuelve a
   someter a sanitización y evaluación") y el aviso indica el resultado: incorporada, en la cola de revisión o de
   nuevo en cuarentena. El pie recuerda que las restauraciones se registran como etiquetas para medir los falsos
   negativos del Juez.
5. **Memoria del proyecto** (`#/memory`): pestañas *Activas* / *Pendientes de revalidación* (vacía hasta que corre el
   job de revalidación, que ejecutan `pnpm demo` y `pnpm smoke`), filtro por tipo, búsqueda y *Cargar más*.
   - *+ Nueva unidad*: elegir el tipo (los campos propios del tipo cambian), completar y pulsar *Previsualizar*: se
     ve el resultado ("Se incorporará a la memoria al confirmar" o "Irá a cuarentena"), el **Veredicto del Juez** y el
     contenido tal como se guardará. *Confirmar* solo se habilita para el contenido previsualizado; al confirmar se
     abre el detalle con la versión 1 en el **Historial de versiones**.
   - *Editar* repite la vista previa y crea la versión 2. *Retirar* pide un motivo (3 a 500 caracteres).
   - En *Pendientes de revalidación*: *Confirmar* la vuelve a activar; *Retirar* la retira.
   - *Retirar por PR*: número de PR y motivo, con una confirmación ("Se retirarán todas las unidades activas
     originadas en la PR n") y el aviso con la cantidad retirada.
6. **Administración** (`#/admin`, solo lectura): datos del proyecto, los dos repositorios con su rama de promoción,
   miembros con rol y las credenciales de servicio con estado y vencimiento, **sin tokens ni hashes**. Las altas y
   bajas se gestionan por ticket.

Después de `pnpm demo`, la decisión nueva ya no está en la cola (fue aprobada), la anterior figura como reemplazada
y las 2 memorias vencidas del seed aparecen en *Pendientes de revalidación*.

Las capturas de `docs/demo/capturas/` se regeneran con `pnpm screenshots` sobre el stack recién levantado (sección 8).

## 7. Conectar un agente real (opcional)

1. Copiar `docs/demo/mcp-local.example.json` como `.mcp.json` en la raíz de un proyecto de prueba (o añadir el servidor con `claude mcp add --transport http gmemo http://localhost:3000/mcp --header "X-Git-Remote: https://github.com/crombie-llc/gmemo-demo.git" --header "X-Git-Branch: feature/notif-async"`). No lleva secretos: en local el *bypass* de desarrollo sustituye al token.
2. Abrir Claude Code en ese proyecto y comprobar que el servidor `gmemo` está conectado (`/mcp`).
3. Prompt de ejemplo:

> Usá gmemo. Primero buscá con `recall` qué decisiones hay sobre el envío de notificaciones a clientes. Después proponé con `remember` un gotcha, en inglés, sobre que el worker del outbox debe confirmar (ack) el trabajo solo cuando el proveedor de email responde 2xx, citando `src/notifications/outboxWorker.ts`. Al final mostrame `list_staged`.

El borrador queda en la sesión de `feature/notif-async`; para promoverlo, seguir el guion 6.2.

## 8. Tests y métricas

| Comando | Qué hace |
|---|---|
| `pnpm test -- --run` | Tests unitarios (los de base de datos se saltan sin `DATABASE_URL`) |
| `docker compose up -d db` y `DATABASE_URL=postgres://gmemo:gmemo@localhost:5433/gmemo pnpm test -- --run` | Suite completa con base de datos (incluye la integridad del seed de la demo). Usa la base de compose y **reinicia su esquema** |
| `pnpm lint` / `pnpm build` | ESLint y compilación TypeScript |
| `pnpm smoke` | Prueba de humo contra el stack levantado |
| `pnpm demo` | El guion de extremo a extremo (sección 6) |
| `pnpm eval` | Métricas sintéticas (TT-06): recall@5, MRR y nDCG@5 del `recall` híbrido (RRF) y tasas de falsos positivos/negativos del juez. Escribe [`metricas.md`](metricas.md). Usa **datos sintéticos** y los **stubs** del juez y del embedder; es determinista |
| `pnpm screenshots` | Capturas de las 5 pantallas en `docs/demo/capturas/` (1440×900, escala 2) contra `http://localhost:3000` como `tl@demo.local`. Necesita `pnpm build:web` (para detectar el build) y el stack levantado; si faltan Playwright o el build, avisa y termina sin error |
| `pnpm package:demo` | Genera `dist-demo/gmemo-demo.zip` y lo verifica (sección 12) |

Tras ejecutar la suite con base de datos, el esquema queda reiniciado: volver a `docker compose down -v && docker compose up --build -d --wait` antes de `pnpm smoke` o `pnpm demo`.

## 9. Historias de usuario → endpoint / herramienta / pantalla

| HU | Qué | Endpoint o herramienta | Pantalla |
|---|---|---|---|
| HU-03.4 | Rechazo de credenciales en la captura | MCP `remember` (escaneo de secretos antes de escribir) | — |
| HU-04.2 | PR cerrado sin merge descarta su staging | `POST /promote` con `event: "closed_unmerged"` | — |
| HU-05 | Sanitización: credenciales, instrucciones embebidas, datos personales enmascarados | Pipeline de `POST /promote` | Cuarentena (`#/quarantine`) |
| HU-06.1–6.6 | Juez: aceptar, duplicado, contradicción/confianza, revisión obligatoria, segunda capa de seguridad | Pipeline de `POST /promote` (`DeterministicJudge` en local) | Cola de revisión (`#/review`) |
| HU-07 | Cola de revisión humana: listar, detalle, aprobar (con reemplazo) o rechazar | `GET /api/v1/projects/:id/review-queue`, `GET …/review-queue/:itemId`, `POST …/approve`, `POST …/reject` | Cola de revisión (`#/review`), Detalle de revisión (`#/review/<itemId>`) |
| HU-08.1 | Recall híbrido (BM25 + vectores, RRF) | MCP `recall` | — |
| HU-08.2, HU-09 | Solo se sirven memorias activas | MCP `recall`, `get_memory`, `get_context` | — |
| HU-08.3 | Prioridad del repositorio de la consulta | MCP `recall` (`scope`) | — |
| HU-08.4 | Borradores propios en el recall | MCP `recall` (`source: "staged"`), `list_staged`, `discard_staged` | — |
| HU-10 | Cuarentena: listar, detalle, restaurar por el pipeline, purga por retención | `GET /api/v1/projects/:id/quarantine`, `GET …/:qid`, `POST …/:qid/restore`, `POST /internal/jobs/quarantine-purge` | Cuarentena (`#/quarantine`) |
| HU-11.3 | Destino obsoleto → revisión obligatoria | MCP `remember` / `POST /promote` (`stale_target`) | Detalle de revisión (`#/review/<itemId>`) |
| HU-11.4 | Retiro masivo por PR revertido | `POST /api/v1/projects/:id/memories/retire-by-pr` | Memoria del proyecto (`#/memory`) |
| HU-12 | Revalidación: vencimiento, confirmar o retirar | `POST /internal/jobs/revalidation-sweep`, `GET …/memories?status=pending_revalidation`, `POST …/memories/:mid/confirm`, `POST …/memories/:mid/retire` | Memoria del proyecto (`#/memory`, pestaña Pendientes de revalidación) |
| HU-13 | Gestión directa con vista previa del juez e historial | `GET/POST …/memories`, `POST …/memories/preview`, `GET/PUT …/memories/:mid` | Memoria del proyecto (`#/memory`) |
| — | Usuario, proyectos y administración de solo lectura (repositorios, miembros, credenciales sin secretos) | `GET /api/v1/me`, `GET /api/v1/projects/:id/admin-summary` | Barra superior y Administración (`#/admin`) |
| TT-06 | Métricas de recuperación y del juez | `pnpm eval` → `docs/demo/metricas.md` | — |

## 10. Simplificaciones frente a la arquitectura AWS

| En AWS (piloto/diseño) | En la demo local |
|---|---|
| Login con Cognito (JWT, OAuth 2.1 + PKCE) | `AUTH_DEV_BYPASS` + `X-Dev-User`; la autorización por rol es la real |
| GitHub OIDC para `/promote` | `PROMOTE_OIDC_DEV_BYPASS` con un principal fijo (`crombie-llc/gmemo-demo`) y la credencial de máquina del seed |
| Bedrock: juez (Claude) y embeddings (Titan v2) | `DeterministicJudge` (reglas documentadas) y `StubEmbedder` (determinista, sin semántica) |
| SQS para desacoplar la promoción | Promoción síncrona dentro de la petición `/promote` |
| SES para avisos (cola de revisión, fugas) | Notificaciones como logs estructurados del servidor |
| EventBridge Scheduler para los jobs | Llamada manual a `POST /internal/jobs/*` (o `pnpm job:*`), abierta solo en desarrollo |
| WAF / CloudFront | Rate limit y cabeceras de seguridad en el propio proceso (express-rate-limit, helmet) |
| Despliegue: ECS Fargate, RDS, ALB + ACM, Route 53, Terraform | `docker compose` con `pgvector/pgvector:pg16` y la imagen del servidor; la web la sirve Express (`WEB_STATIC_DIR`, prohibido en producción) |
| Merge del PR promueve la sesión de su rama | El piloto promueve la sesión de la rama por defecto (ver 6.2) |

## 11. Solución de problemas

- **El puerto 5432 está ocupado**: es normal si hay un PostgreSQL local; compose publica Postgres en el **5433** del host. Usar `postgres://gmemo:gmemo@localhost:5433/gmemo`.
- **El puerto 3000 está ocupado**: liberar el puerto o cambiar el mapeo `127.0.0.1:3000:3000` de `docker-compose.yml` (y usar `BASE_URL=http://localhost:<puerto>` con `pnpm smoke`/`pnpm demo`).
- **Datos raros o quiero empezar de cero**: `docker compose down -v && docker compose up --build -d --wait` (borra el volumen y vuelve a aplicar migraciones y seed).
- **Error de caché de Docker BuildKit** al construir (por ejemplo "failed to compute cache key" o "failed to solve"): reintentar `docker compose up --build -d --wait`; si persiste, `docker builder prune` y reintentar.
- **`pnpm demo` termina con código 2**: el stack no responde; revisar `docker compose ps` y `docker compose logs app`.
- **Respuestas 429**: se superó el rate limit (por ejemplo 10 llamadas por minuto a `/promote`); esperar un minuto.
- **La suite con base de datos dejó el stack sin datos**: es esperado (reinicia el esquema); volver a levantar con `down -v`.

## 12. Paquete de entrega

```sh
pnpm package:demo
```

Genera `dist-demo/gmemo-demo.zip` con el código, `openspec/` y `docs/demo/`, sin dependencias (`node_modules`), control de versiones (`.git`), herramientas locales (`.claude`, `.mcp.json`, `CLAUDE.md`), material personal (entrevistas, prompts), compilados (`dist`) ni secretos (`.env`, `*.tfvars`, estado de Terraform; se conservan los `*.example`), claves (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`) ni configuración de otros agentes (`.codex/`, `.cursor/`, `.windsurf/`, `.aider*`). Al final descomprime el zip en un directorio temporal y lo revisa con los patrones de saneamiento; si encuentra algo, falla.

La revisión **falla cerrada**: requiere el archivo local `.sanitize-patterns` (ignorado por git, una expresión regular extendida por línea). Si falta o está vacío, el script termina con error y no genera el paquete. Solo para un caso excepcional se puede continuar sin patrones con `ALLOW_NO_PATTERNS=1 pnpm package:demo`, que imprime una advertencia y deja solo la revisión de rutas prohibidas. Nunca se imprime el texto coincidente, solo las rutas de los archivos.
