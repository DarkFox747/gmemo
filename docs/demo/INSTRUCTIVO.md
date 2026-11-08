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

Compose aplica las migraciones y el seed de desarrollo (servicio `migrate`) y arranca el servidor cuando la base está lista. Para volver a empezar desde cero: `pnpm demo:reset` (equivale a `docker compose down -v && docker compose up --build -d --wait`).

### 3.1 Ayudantes de demo

| Comando | Qué hace |
|---|---|
| `pnpm demo:reset` | Recrea el stack desde cero (borra el volumen) y espera a que esté sano |
| `pnpm demo:promote -- --branch <rama> [--pr <n>]` | Llama a `POST /promote` con el *bypass* OIDC de desarrollo e imprime el resultado; una rama feature exige `--pr` (`BASE_URL` cambia el servidor, por defecto `http://localhost:3000`) |

### 3.2 Web: actualización en vivo y atajos

- La cola de revisión, la cuarentena y los contadores del menú se refrescan solos cada 5 segundos mientras la pestaña está visible (se pausan si está oculta); los filtros y el scroll se mantienen. Tras `pnpm demo:promote` las unidades dudosas aparecen sin recargar.
- En el detalle de revisión: `A` arma la aprobación y aparece "Pulsá A otra vez o Enter para confirmar" (3 s para confirmar, si no se desarma); `R` solo lleva al motivo de rechazo (rechazar es siempre con el botón). No actúan mientras se escribe en un campo ni con Shift/Ctrl/Alt/Meta.
- El detalle muestra la explicación del criterio en español, el "Texto original del Juez" y, si hay unidad relacionada, la comparación lado a lado con las palabras cambiadas resaltadas.

## 4. URLs

| Qué | URL |
|---|---|
| Salud | `http://localhost:3000/health` |
| Servidor MCP (agentes) | `http://localhost:3000/mcp` |
| API REST de la web | `http://localhost:3000/api/v1` (por ejemplo `/api/v1/me`) |
| Promoción por merge | `POST http://localhost:3000/promote` |
| Jobs programados (modo abierto solo en desarrollo) | `POST http://localhost:3000/internal/jobs/revalidation-sweep`, `/quarantine-purge`, `/web-session-reaper` |
| Web de gobierno (C7) | `http://localhost:3000/` (rutas por hash: `#/home`, `#/review`, `#/staging`, `#/memory`, `#/search`, `#/quarantine`, `#/activity`, `#/admin`; sin ruta abre Inicio) |
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
| 4 | Merge simulado con el *bypass* OIDC de desarrollo: se promueve directamente `feature/notif-async` con el número de su PR | Ver 6.2. Sin `pr_number` se rechaza; con `pr_number`, resumen de `/promote`: gotcha **aplicado**, decisión **a la cola humana**, inyección y duplicado **a cuarentena**, y la sesión de la rama queda cerrada |
| 5 | Como líder técnico: cola de revisión y aprobación | La decisión está como dudosa (`contradiction`) con la decisión anterior como relacionada; se aprueba marcando la anterior como **reemplazada** |
| 6 | Cuarentena y restauración | La inyección y el duplicado están en cuarentena; restaurar el duplicado **vuelve a pasar todo el pipeline** y, como sigue duplicando una memoria activa, vuelve a cuarentena como entrada nueva (restaurar nunca salta la validación) |
| 7 | Job de revalidación | Las 2 memorias vencidas del seed pasan a `pending_revalidation` |
| 8 | `recall` final en `main` | Aparecen la decisión nueva y el gotcha; **no** aparecen la decisión reemplazada ni las memorias vencidas |

### 6.2 Cómo se simula el merge (decisión honesta)

La sesión de staging es por rama y el merge del PR promueve la sesión de la rama de origen (HU-04.1). Así funciona el piloto:

- El workflow `promote.yml` se dispara con el **push a la rama por defecto** (el merge del PR). Pide un token OIDC, que GitHub emite con `ref: refs/heads/<rama por defecto>`, y busca el PR asociado al commit del merge con la API de GitHub (`GITHUB_TOKEN`, permiso `pull-requests: read`). Si hay exactamente un PR mergeado, del mismo repositorio y con destino la rama por defecto, envía `source_branch = <rama del PR>` y `pr_number`; si no (push directo, ningún PR o varios), envía la rama por defecto.
- `POST /promote` exige que el token se haya emitido en la rama por defecto (un token de un workflow de PR o de una rama feature se rechaza) y, si `source_branch` no es la rama por defecto, que venga `pr_number`. La memoria aplicada guarda `origin_branch` = rama feature y `origin_pr` = número del PR.
- Límite de confianza: el PR lo resuelve el workflow a partir del commit del merge; el servidor **no** vuelve a verificar el PR contra la API de GitHub (necesitaría una GitHub App o un token en el servidor y queda fuera del alcance). La garantía es que solo el workflow de la rama por defecto, que ejecuta código revisado, puede obtener un token aceptado: el servidor exige `event_name = push` y `job_workflow_ref = <repo>/.github/workflows/promote.yml@refs/heads/<rama por defecto>`, así que otro workflow o evento (`workflow_dispatch`, `schedule`, `pull_request_target`) se rechaza.

El script lo reproduce con el *bypass* OIDC de desarrollo (el principal fijo informa `ref: refs/heads/main`, igual que el token real del workflow):

1. llama a `/promote` con `source_branch: feature/notif-async` **sin** `pr_number` y comprueba que **se rechaza** (respuesta opaca);
2. llama a `/promote` con `source_branch: feature/notif-async` y `pr_number`, exactamente lo que envía el workflow tras el merge, y comprueba que la sesión de la rama queda cerrada.

Todo lo que ocurre después (sanitización, juez, cola, cuarentena, aplicación idempotente) es el código real.

### 6.3 En la web (`http://localhost:3000/`)

Abrir `http://localhost:3000/` con el stack recién levantado. La barra superior tiene el selector **Proyecto**
("Portal de Clientes"), el selector **Usuario de desarrollo** y el rol con las iniciales. La barra lateral muestra
las insignias de pendientes (cola) y de entradas en cuarentena. Sin ruta (o con una desconocida) se abre **Inicio**.

| Pantalla | Ruta | Captura |
|---|---|---|
| Inicio | `#/home` | [`capturas/6-inicio.png`](capturas/6-inicio.png) |
| Cola de revisión (Fig. 12) | `#/review` | [`capturas/1-cola-de-revision.png`](capturas/1-cola-de-revision.png) |
| Detalle de revisión (Fig. 13) | `#/review/<itemId>` | [`capturas/2-detalle-de-revision.png`](capturas/2-detalle-de-revision.png) |
| Cuarentena (Fig. 14) | `#/quarantine` (detalle `#/quarantine/<id>`) | [`capturas/3-cuarentena.png`](capturas/3-cuarentena.png) |
| Memoria del proyecto (Fig. 16) | `#/memory` (`#/memory/new`, `#/memory/<id>`, `#/memory/<id>/edit`) | [`capturas/4-memoria-del-proyecto.png`](capturas/4-memoria-del-proyecto.png) |
| Administración (Fig. 15) | `#/admin` | [`capturas/5-administracion.png`](capturas/5-administracion.png) |
| Actividad | `#/activity` | [`capturas/7-actividad.png`](capturas/7-actividad.png) |
| Área de preparación | `#/staging` | [`capturas/8-area-de-preparacion.png`](capturas/8-area-de-preparacion.png) |
| Buscar como agente | `#/search` | [`capturas/9-buscar-como-agente.png`](capturas/9-buscar-como-agente.png) |
| Comparar versiones (detalle de memoria) | `#/memory/<id>` | [`capturas/10-historial-de-versiones.png`](capturas/10-historial-de-versiones.png) |

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
   positivos del Juez (unidades buenas que el Juez retuvo).
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

7. **Inicio / Actividad / Área de preparación** (solo lectura, solo líder técnico): ver la sección 6.4.
8. **Buscar como agente y Comparar versiones** (solo lectura, solo líder técnico): ver la sección 6.5.

Después de `pnpm demo`, la decisión nueva ya no está en la cola (fue aprobada), la anterior figura como reemplazada
y las 2 memorias vencidas del seed aparecen en *Pendientes de revalidación*.

Las capturas de `docs/demo/capturas/` se regeneran con `pnpm screenshots` sobre el stack recién levantado (sección 8).

### 6.4 Vistas de gobierno: Inicio, Actividad y Área de preparación

Tres vistas de **solo lectura** para el líder técnico (un colaborador o lector ve "Sin permisos" y la web no llama
a la API). Se actualizan con el botón *Actualizar*; no hay refresco automático.

- **Inicio** (`#/home`, `GET /api/v1/projects/:id/dashboard`): memorias por estado y activas por tipo; pendientes
  de la cola (mismo número que la insignia) y entradas en cuarentena por criterio, con accesos a esas pantallas;
  **Decisiones del Juez** de los últimos 30 días (aceptadas, dudosas, rechazadas por el Juez, bloqueadas por la
  sanitización y sin evaluación); **Correcciones humanas** de los últimos 30 días; y los **indicadores del Juez con
  datos reales**, calculados con las etiquetas que ya guarda el sistema:
  - **Falsos positivos** = unidades buenas que el Juez retuvo / unidades buenas etiquetadas, con
    *buena* = aprobada en revisión o restaurada desde una cuarentena del Juez. Numerador: dudosas aprobadas +
    cuarentenas del Juez restauradas; denominador: eso más las aceptadas por el Juez y aprobadas en revisión
    obligatoria.
  - **Falsos negativos** = unidades malas que el Juez dejó pasar / unidades malas etiquetadas, con
    *mala* = rechazada en revisión. Numerador: aceptadas por el Juez y rechazadas en revisión obligatoria;
    denominador: eso más las dudosas rechazadas.
  - Sin etiquetas el indicador dice **"sin datos"** (nunca 0 %). Cada valor muestra "n de m".
  - **Qué no es medible** (se informa como cobertura "sin etiqueta", nunca dentro de una tasa): las unidades
    aceptadas y aplicadas automáticamente (nadie las miró), los rechazos del Juez que nadie restauró (el silencio no
    es acuerdo), los bloqueos de la sanitización (no son decisiones del Juez; sus restauraciones se muestran como
    "otras restauraciones") y las propuestas sin evaluación (destino cambiado o Juez no disponible). Los falsos
    negativos solo se observan en los tipos con revisión obligatoria, así que la muestra está sesgada; la
    contraparte sintética está en [`metricas.md`](metricas.md).
- **Actividad** (`#/activity`, `GET …/activity`): línea de tiempo del registro de auditoría (propuestas y descartes
  de agentes, promociones con sus contadores, PR cerradas sin merge, aprobaciones y rechazos, restauraciones, altas,
  ediciones, revalidaciones y retiros desde la web, y tareas de la plataforma que tocaron el proyecto). Muestra
  actor ("Agente · nombre", "CI", "Sistema" o el nombre del usuario), acción, objeto (tipo y título, o "—") y un
  detalle corto. Filtros por categoría y *Cargar más*. Nunca muestra lecturas, hashes, correos, identidades ni
  contenido más allá de los títulos.
- **Área de preparación** (`#/staging`, `GET …/staging`): pestañas *Abiertas* y *Cerradas (7 días)*; una tarjeta
  por sesión (repositorio, rama, PR, estado, quién la abrió, última actividad, vencimiento o cierre) con sus
  propuestas: tipo, título (con datos personales enmascarados), operación, estado del Juez y estado de la propuesta
  (En preparación, En cola de revisión, Incorporada, En cuarentena, Rechazada en revisión). Las sesiones internas
  `restore/` y `web/` no se listan.

### 6.5 Buscar como agente y Comparar versiones

- **Buscar como agente** (`#/search`, `GET /api/v1/projects/:id/search?q=&types=&limit=&repoId=`): muestra lo que
  un agente obtendría de `recall` para una consulta y por qué. Usa **la misma función de ranking** que la
  herramienta MCP `recall` (un solo camino de código): solo memorias activas (se excluyen las reemplazadas, las
  retiradas, las pendientes de revalidación y los borradores en preparación de cada agente), las 50 mejores de la
  lista léxica (BM25 con decaimiento temporal) y de la semántica (pgvector), fusionadas con RRF:
  puntuación = Σ 1/(60 + rango). Formulario: *Consulta* (hasta 200 caracteres), *Tipos* (pastillas), *Resultados*
  (1 a 8, por defecto 5) y *Repositorio del agente* (por defecto "Ninguno"; la lista sale de la Administración).
  Elegir el repositorio del agente reproduce su orden exacto: sus memorias aparecen primero. La tabla muestra
  posición, título (enlace al detalle), tipo, repositorio, puntuación (4 decimales), rango léxico y rango
  semántico ("—" si no aparece en esa lista). Si el servicio de embeddings no responde, un aviso indica que los
  resultados son solo léxicos. La búsqueda solo se ejecuta al pulsar *Buscar* y se audita como lectura
  `memories.search` con el hash de la consulta (misma normalización que `recall`), nunca el texto. Con el embedder
  stub de la demo el rango semántico no tiene significado real (es determinista, no semántico).
- **Comparar versiones** (detalle de una memoria con dos o más versiones, por ejemplo la restricción "Customer PII
  never leaves the eu-west-1 region", con 3 versiones en el seed): dos selectores *Desde la versión* y *Hasta la
  versión* (por defecto la anterior y la actual). Título, resumen y desarrollo se comparan palabra a palabra, lado a
  lado (palabras eliminadas en la versión anterior, añadidas en la nueva); un cambio de tipo se muestra en una
  fila; los campos se comparan clave a clave (añadido, eliminado o modificado) o "Sin cambios en campos". Elegir la
  misma versión dos veces muestra un aviso. Se calcula en la web con el historial que ya devuelve el detalle.

## 7. Conectar un agente real (opcional)

1. Copiar `docs/demo/mcp-local.example.json` como `.mcp.json` en la raíz de un proyecto de prueba (o añadir el servidor con `claude mcp add --transport http gmemo http://localhost:3000/mcp --header "X-Git-Remote: https://github.com/crombie-llc/gmemo-demo.git" --header "X-Git-Branch: feature/notif-async"`). No lleva secretos: en local el *bypass* de desarrollo sustituye al token.
2. Abrir Claude Code en ese proyecto y comprobar que el servidor `gmemo` está conectado (`/mcp`).
3. Prompt de ejemplo:

> Usá gmemo. Primero buscá con `recall` qué decisiones hay sobre el envío de notificaciones a clientes. Después proponé con `remember` un gotcha, en inglés, sobre que el worker del outbox debe confirmar (ack) el trabajo solo cuando el proveedor de email responde 2xx, citando `src/notifications/outboxWorker.ts`. Al final mostrame `list_staged`.

El borrador queda en la sesión de `feature/notif-async`. Esa sesión se promueve directamente al mergear su PR: en local, con `pnpm demo:promote -- --branch feature/notif-async --pr <n>` (ver 6.2); después, la cola de la web muestra las unidades dudosas en pocos segundos.

## 8. Tests y métricas

| Comando | Qué hace |
|---|---|
| `pnpm test -- --run` | Tests unitarios (los de base de datos se saltan sin `DATABASE_URL`) |
| `docker compose up -d db` y `DATABASE_URL=postgres://gmemo:gmemo@localhost:5433/gmemo pnpm test -- --run` | Suite completa con base de datos (incluye la integridad del seed de la demo). Usa la base de compose y **reinicia su esquema** |
| `pnpm lint` / `pnpm build` | ESLint y compilación TypeScript |
| `pnpm smoke` | Prueba de humo contra el stack levantado |
| `pnpm demo` | El guion de extremo a extremo (sección 6) |
| `pnpm eval` | Métricas sintéticas (TT-06): recall@5, MRR y nDCG@5 del `recall` híbrido (RRF) y tasas de falsos positivos/negativos del juez. Escribe [`metricas.md`](metricas.md). Usa **datos sintéticos** y los **stubs** del juez y del embedder; es determinista |
| `pnpm screenshots` | Capturas de las 10 vistas en `docs/demo/capturas/` (1440×900, escala 2) contra `http://localhost:3000` como `tl@demo.local`. Necesita `pnpm build:web` (para detectar el build) y el stack levantado; si faltan Playwright o el build, avisa y termina sin error |
| `pnpm package:demo` | Genera `dist-demo/gmemo-demo.zip` y lo verifica (sección 12) |

Tras ejecutar la suite con base de datos, el esquema queda reiniciado: volver a `docker compose down -v && docker compose up --build -d --wait` antes de `pnpm smoke` o `pnpm demo`.

## 9. Historias de usuario → endpoint / herramienta / pantalla

| HU | Qué | Endpoint o herramienta | Pantalla |
|---|---|---|---|
| HU-03.4 | Rechazo de credenciales en la captura | MCP `remember` (escaneo de secretos antes de escribir) | — |
| HU-04.1 | El merge del PR promueve la sesión de su rama (registra rama y PR de origen) | `POST /promote` con `source_branch` = rama del PR y `pr_number` (workflow `promote.yml`) | — |
| HU-04.2 | PR cerrado sin merge descarta su staging | `POST /promote` con `event: "closed_unmerged"` | — |
| HU-05 | Sanitización: credenciales, instrucciones embebidas, datos personales enmascarados | Pipeline de `POST /promote` | Cuarentena (`#/quarantine`) |
| HU-06.1–6.6 | Juez: aceptar, duplicado, contradicción/confianza, revisión obligatoria, segunda capa de seguridad | Pipeline de `POST /promote` (`DeterministicJudge` en local) | Cola de revisión (`#/review`) |
| HU-07 | Cola de revisión humana: listar, detalle, aprobar (con reemplazo) o rechazar | `GET /api/v1/projects/:id/review-queue`, `GET …/review-queue/:itemId`, `POST …/approve`, `POST …/reject` | Cola de revisión (`#/review`), Detalle de revisión (`#/review/<itemId>`) |
| HU-08.1 | Recall híbrido (BM25 + vectores, RRF) | MCP `recall`; explorador `GET /api/v1/projects/:id/search` (misma función de ranking, con rango léxico/semántico y puntuación) | Buscar como agente (`#/search`) |
| HU-08.2, HU-09 | Solo se sirven memorias activas | MCP `recall`, `get_memory`, `get_context` | — |
| HU-08.3 | Prioridad del repositorio de la consulta | MCP `recall` (`scope`); explorador con `repoId` | Buscar como agente (`#/search`, selector *Repositorio del agente*) |
| HU-08.4 | Borradores propios en el recall | MCP `recall` (`source: "staged"`), `list_staged`, `discard_staged` | — |
| HU-10 | Cuarentena: listar, detalle, restaurar por el pipeline, purga por retención | `GET /api/v1/projects/:id/quarantine`, `GET …/:qid`, `POST …/:qid/restore`, `POST /internal/jobs/quarantine-purge` | Cuarentena (`#/quarantine`) |
| HU-11 | Las correcciones conservan el historial | `GET /api/v1/projects/:id/memories/:mid` (`revisions[]`) | Detalle de memoria (`#/memory/<id>`, Comparar versiones) |
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
