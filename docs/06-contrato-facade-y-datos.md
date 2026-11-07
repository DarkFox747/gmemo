# 06 · Contrato del facade y modelo de datos

Contrato completo en `artefactos/lpms_facade_contract_v1.md`. Esquema en `artefactos/lpms_schema_v2.sql`
(validado contra la gramática de PostgreSQL con pglast).

## Superficie del agente
- **Lectura** (membresía en el proyecto): `recall(query, scope?, types?, limit?)`, `get_memory(handle)`,
  `get_context()`. Tools de grafo aparte: `trace_call_path`, `get_architecture`, `search_graph`.
- **Escritura a staging** (contributor/agent): `remember(op, type, title, summary, body, fields?, target_handle?)`,
  `list_staged`, `discard_staged`.
- **No expuestas al agente:** `save`/`update`/`delete` de main, `promote` (pipeline / Web UI humana).
- El contexto (project/session/branch/IDs) lo resuelve el **server**, no la IA.

## Forma del registro devuelto por recall
`{ handle, type, title, summary, body, fields, date, origin{branch,pr}, source(main|staged) }`.
**Sin `status`** (el server ya entrega solo `active`). `origin.branch` = nombre literal de la rama.

## Presupuestos (v1, ajustables)
- `body` por memoria ≤ 2.000 car. (~500 tokens) — garantiza que recall no corta a la mitad.
- `recall`: K=8, ~3.000 tokens, registros **enteros** hasta el tope; `total_matches` + cursor.
- `get_context`: ~2.000–2.500 tokens, constraints/domain-rules primero (nunca se descartan por presupuesto).
- `get_memory(handle)`: un registro con máximo detalle (para profundizar cuando recall recortó el set).

## Reglas clave del contrato
- `op` es **sugerencia**; el juez es la autoridad y puede reclasificar en la promoción.
- `target_handle` opaco, ligado a (memory_id, revision); si la memoria cambió → uncertain.
- `recall` devuelve main + la staging de la **sesión activa** marcada `source:staged` (continuidad tras
  compactación; el agente la trata como borrador propio, no como autoridad).
- Dedup en el stage por content_hash dentro de la sesión (no-op si repetido).
- Errores **sin fuga**: remote no registrado → "no disponible"; sin permiso → negación genérica; nunca
  enumerar tenants.
- Auditoría: toda lectura se loguea con `query_hash`.

## Modelo de datos (esquema v2, RDS)
Alcance: Layer 1 (memoria) + tenancy + staging + auditoría. El grafo vive en cbm; en RDS solo mapeo de repos
+ metadata de build.
- **memory** — estado actual, estructurada (title/summary/body/fields), content_tsv (FTS GIN), status,
  provenance (pr_reviewed|manual_ui), author_identity, content_hash, current_revision, origin_branch, origin_pr,
  ttl_days. UNIQUE(project_id, content_hash). CHECKs de longitud.
- **memory_revision** — historial inmutable (amend agrega versión).
- **memory_relation** — supersedes|conflicts_with|duplicate (juez propone, humano confirma).
- **staging_session** — id ULID, (project,repo,branch), status, pr_number, last_activity_at, expires_at;
  índice único parcial (una open por clave).
- **staging_item** — op, type, title/summary/body/fields, content_hash, target_memory_id, judge_state,
  sanitize_flags. CHECK add↔target. UNIQUE(session_id, content_hash).
- **project / repo** (repo.remote_url = identidad), **app_user / project_membership**, **machine_credential**
  (token_hash), **access_log** (auditoría con query_hash).

Pendientes de esquema para prod: `promoted_at`/`promoted_memory_id` en staging_item (idempotencia por item),
estado `partially_promoted`, tabla `quarantine`, y FTS `english`.
