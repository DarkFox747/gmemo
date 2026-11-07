# 04 · Escritura, staging y promoción

## Principio
Una sola ruta de escritura a main: **merge de PR o humano (Web UI)**. Los agentes solo **leen y proponen
(stage)**. Reemplaza el modelo de "dos puertas" de v0.1.

## Sesiones de staging
- **Identidad del repo sin config en el repo:** el server mapea el **remote de git** (y el slug de GitHub del
  lado CI) a (project, repo). No se commitea nada al repositorio.
- **Clave de sesión = (project, repo, branch).** Creación lazy en el primer `remember`. Worktrees soportados
  gratis (la clave es el branch, no el path). Índice único parcial: una sola sesión `open` por (project,repo,branch).
- **Vencimiento:** TTL deslizante 7 días por inactividad (solo escrituras). Una sesión ligada a un PR abierto
  **no expira**. PR cerrado sin merge → sesión descartada.
- **Staging vive en tabla cloud, NO en archivos del repo** (evita contaminar el grep del agente).

## Las cuatro operaciones (todas por el mismo embudo)
- **add** — memoria nueva.
- **amend** — corrección puntual, versionada (conserva historial, no pisa).
- **supersede** — una decisión nueva reemplaza a una vieja (la vieja → superseded).
- **deprecate** — retiro sin reemplazo.
El agente referencia el target con un **handle opaco** que le devolvió el `recall` (no maneja IDs crudos).

## Binding: TODO por rama, el repo no toca memoria
La pipeline del repo es **tonta a propósito**: dispara siempre en el merge y manda `{repo, source_branch(head),
target_branch(base), pr_number, merge_sha}`. El **server** resuelve la sesión por `(project, repo, branch)` — la
pregunta "¿este PR tiene memoria?" la responde el server, no la Action. **No se estampa nada en el PR.**
Tres webhooks (todos por rama, sin conocimiento de memoria):
1. **PR abierto** → pinnea la sesión (no expira).
2. **PR mergeado** → dispara la promoción; registra `origin_pr` + `origin_branch`.
3. **Rama borrada** → marca `abandoned` la sesión (cierra el reuso de nombre); TTL como backstop.
La **rama de promoción es configurable por proyecto, SIN default** (se pregunta en el alta). El trigger del
build del grafo (rama principal del repo) puede o no coincidir con la rama de promoción de la memoria.

## Pipeline de promoción
Merge → GitHub Action (OIDC, solo dispara) → **server** `promote(sesión)` → valida que la sesión pertenece al
repo del claim → por cada item: **sanitización** (tipo, masking PII, secret-scan, normalización, clasificador de
inyección) → **juez** → aplica el `op` contra main **idempotente** (por content_hash). Es **post-merge → no
bloquea el merge**; best-effort por item. La lógica dura vive en el **server** (la Action solo dispara; el juez
NO tiene tools de escritura).

- **Idempotencia por item** (no solo por sesión): re-runs no re-aplican; sumar `promoted_at`/`promoted_memory_id`
  al staging_item.
- **Estado de sesión:** agregar `partially_promoted`; los pendientes quedan en la cola.
- **Hash:** el hash **as-staged** manda para idempotencia/dedup; en main se guarda el texto **ya sanitizado**.
- **Secret-scan también en el stage** (sincrónico, antes de persistir) para que un secreto no quede en texto plano.
  Lo pesado (normalización) puede ser async con estado `scanning` invisible a recall.
- **Rollback por PR:** como cada memoria lleva `origin_pr`, "revertir PR #X" = deprecar en bloque por origin_pr.

## Juez de 3 estados (evaluador, no escritor)
- **accepted** → promueve automático.
- **rejected** → no promueve, alerta + registro; va a cuarentena.
- **uncertain** → cola de revisión (Web UI) + notificación; humano autoriza.
Umbral más estricto para tipos de alto valor (constraint, decision). Candidatos por FTS (v1; el conflicto
semántico con palabras totalmente distintas no se surfacea hasta pgvector — gap aceptado). **Blindaje anti-inyección
del juez:** contenido como dato, salida solo estructurada, clasificador antes del juez. **Fail-closed** (si el LLM
cae, va a uncertain, nunca auto-accept). Veredicto **persistido** → re-run no re-juzga. LLM del juez en **Bedrock**.

## #7 — Target movido entre stage y merge (concurrencia optimista)
`staging_item.target_revision` = revisión que vio el agente. En promoción compara con `current_revision`:
- igual → aplica directo.
- movido → **reconciliación 3-vías**: por campo (memoria estructurada). Campos distintos = aditivo → auto-merge
  (una completa a la otra). Mismo campo distinto = conflicto → juez → uncertain → humano. Prosa la evalúa el juez.
- `amend` manda el registro completo; el server calcula el diff. Lock por fila sobre la memoria (serializa concurrentes).
- Target superseded/deprecated → NO auto-redirigir → uncertain (la Web UI muestra "M fue reemplazada por N: ¿aplicar a N?").
- `supersede` sobre cadena → sigue hasta la cabeza activa, juez confirma; ambiguo → humano.
- Target borrado → rechazo con motivo → cuarentena.
- Referencias intra-sesión: amend/supersede/deprecate solo apuntan a memorias YA en main; corregir un borrador propio
  = `discard_staged` + `remember` de nuevo.

## Cuarentena (rechazos)
Tabla propia `quarantine`, retención **1-2 meses** (a confirmar), recuperable desde la Web UI. Restaurar = escritura
`manual_ui` por el mismo core (sanitización + juez), con un humano. **Secretos nunca en cuarentena en crudo** →
versión redactada + motivo. Ven/restauran Project Admin + autor.

## Contextos sin PR (Cowork / main directo)
No tienen ruta de merge → van a la **cola humana de la Web UI**. (Atenea es el caso canónico — ver 07.)
