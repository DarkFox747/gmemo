# gmemo — Contrato del facade MCP (v1)

Superficie de tools que ve el agente, con sus parámetros, forma de respuesta,
presupuestos, enforcement de RBAC y comportamiento de errores.

## 0. Principios del contrato

- El agente ve **dos verbos de memoria** (`recall`, `remember`) más `get_memory`,
  `get_context`, y la gestión de su propio staging (`list_staged`, `discard_staged`).
  Las tools de grafo (`trace_call_path`, `get_architecture`, `search_graph`) son aparte.
- **`remember` siempre escribe a staging.** No existe `save`/`update`/`delete` de main
  en la superficie del agente. La **promoción a main NO es una tool** (la dispara el
  merge del PR).
- **El contexto lo resuelve el servidor, no la IA.** El agente nunca manda `project_id`,
  `session_id`, ni IDs de memoria crudos. El servidor los deriva de:
  - identidad → del token (JWT / service principal);
  - `project` + `repo` → del **remote de git** que reporta el cliente (mapeo en RDS);
  - `branch` → reportado por el hook del cliente;
  - `session` → (project, repo, branch), creada lazy en el primer `remember`.

## 1. Formato del registro de memoria

Toda memoria devuelta o propuesta tiene esta forma:

```json
{
  "handle": "opaco, por-recall, ligado a (memory_id, revision)",
  "type": "decision | constraint | gotcha | pattern | integration_note | domain_rule | outcome",
  "title": "string (<=120)",
  "summary": "string (<=200)  — el 'qué' en una línea",
  "body": "markdown (<=2000)  — el desarrollo / rationale",
  "fields": { "…campos por tipo…" },
  "date": "ISO-8601 (promovido)",
  "origin": { "branch": "feature/checkout-sqs", "pr": 482 },
  "source": "main | staged"
}
```

- **No se devuelve `status`.** El servidor ya filtra: sólo entrega `active`.
- `fields` por tipo (guiados por el skill): decision→`alternatives[]`,`drivers[]` ·
  constraint→`rule`,`scope`,`consequence` · gotcha→`symptom`,`root_cause`,`fix` ·
  integration_note→`system`,`quirk`,`workaround` · domain_rule→`rule`,`enforced_in` ·
  outcome→`about`,`result`,`metrics` · pattern→`statement`,`applies_to`.
- `origin.branch` = **nombre literal de la rama** que originó la memoria.

## 2. Tools de lectura

### recall(query, scope?, types?, limit?)
Búsqueda híbrida (léxica BM25 + semántica) sobre la memoria del proyecto.

| Param | Tipo | Default | Notas |
|---|---|---|---|
| `query` | string | — | consulta en lenguaje natural o términos |
| `scope` | `repo` \| `project` | `project` (config. por proyecto) | `repo` primero + boost; `project` amplía |
| `types` | lista de `memory_type` | todos | filtro opcional |
| `limit` | int | 8 | tope de resultados |

**Respuesta:** lista de registros **completos** (sección 1), ordenados por ranking
híbrido con time-decay. Reglas de presupuesto:

- Devuelve registros **enteros** hasta ~**3.000 tokens** o `limit` (lo que ocurra primero).
  Nunca trunca un registro a la mitad (garantizado por el tope de `body` ≤2.000 car.).
- Incluye `total_matches` y un `cursor` para pedir la siguiente tanda.
- Devuelve `active` únicamente; incluye además la **staging de la sesión activa**
  marcada `source: "staged"` (ver §5).

### get_memory(handle)
Trae **una** memoria con el máximo detalle: registro completo + relaciones
(`supersedes`/`conflicts_with`) + referencias. Se usa cuando `recall` recortó el set
por presupuesto y el agente quiere profundizar en un ítem puntual.

### get_context()
Primado de arranque de sesión, **sin query**. Trae lo que hay que saber antes de tocar código:

- **Siempre:** todos los `constraint` y `domain_rule` activos del repo/proyecto
  (prioridad; no se descartan por presupuesto).
- **Recientes:** `decision` y `gotcha` nuevos del repo (time-decay).
- **Alcance:** repo-first → proyecto. **Presupuesto:** ~2.000–2.500 tokens, registros enteros.
- Excluye `superseded`/`deprecated`; incluye activos vencidos por TTL, marcándolos `stale: true`.
- Lo llama el cliente/skill una vez al arranque, no en loop.

## 3. Tool de escritura (a staging)

### remember(op, type, title, summary, body, fields?, target_handle?)

| Param | Tipo | Notas |
|---|---|---|
| `op` | `add` \| `amend` \| `supersede` \| `deprecate` | **sugerencia**; el juez es la autoridad y puede reclasificar en la promoción |
| `type` | `memory_type` | requerido |
| `title` / `summary` / `body` | string | límites: 120 / 200 / 2.000 car. |
| `fields` | objeto | campos por tipo (opcional, guiado por el skill) |
| `target_handle` | handle | requerido salvo en `add`; referencia la memoria que amend/supersede/deprecate |

- Escribe en la **sesión activa** (project, repo, branch), creada lazy si no existe.
- `target_handle` es opaco y está ligado a `(memory_id, revision)`. Si la memoria cambió
  desde el `recall` (revisión distinta), el servidor lo detecta y el item queda `uncertain`
  para revisión humana.
- **Idempotencia:** un `content_hash` repetido en la misma sesión es no-op (evita que un
  loop del agente infle el staging).
- **Respuesta:** el `staging_item` creado (id + estado) para poder `discard_staged`.

### list_staged() / discard_staged(item_id)
Gestión de la **propia** sesión: listar borradores y descartar uno. No tocan main.

## 4. RBAC por tool

| Tool | Rol mínimo |
|---|---|
| `recall`, `get_memory`, `get_context`, tools de grafo | membresía en el proyecto (viewer+) |
| `remember`, `list_staged`, `discard_staged` | `contributor` o `service_agent` |
| `save` / `update` / `delete` de main, `promote` | **no expuestas** (pipeline / Web UI humana) |

- Enforcement en el facade contra la tabla `project_membership`, por cada request.
- El aislamiento por proyecto se aplica en el servidor; el cliente nunca elige el tenant.

## 5. Staging en las lecturas

`recall` devuelve la staging de la sesión activa mezclada con main, pero **marcada
`source: "staged"`**. El agente la trata como **borrador propio, no como autoridad**:
sirve para continuidad tras una compactación, no para citar como hecho establecido.
Sesiones paralelas (otras ramas) no se ven entre sí.

## 6. Errores (sin fuga de información)

- **Remote no registrado / sin proyecto:** "memoria no disponible en este contexto".
  Nunca se enumeran proyectos ni tenants.
- **Sin permiso:** negación genérica, sin revelar si el recurso existe.
- **Handle inválido o vencido:** error de referencia; el agente debe volver a `recall`.

## 7. Auditoría

- Toda lectura (`recall`/`get_memory`/`get_context`) se registra en `access_log` con
  actor, proyecto, acción y `query_hash` (hash de la consulta, no el texto).
- Toda escritura a staging y toda promoción se registran con actor y operación.

## 8. Presupuestos (v1, a ajustar con uso real)

| Límite | Valor |
|---|---|
| `body` por memoria | ≤ 2.000 caracteres (~500 tokens) |
| `recall` | K=8 · ~3.000 tokens · registros enteros |
| `get_context` | ~2.000–2.500 tokens · constraints primero |
| `get_memory` | un registro, detalle completo (sin tope de set) |
