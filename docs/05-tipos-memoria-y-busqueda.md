# 05 · Tipos de memoria y búsqueda

## Qué se guarda — regla madre
Se guarda **el porqué que no se puede reconstruir leyendo el código**. Si es derivable del código actual,
NO va a LPMS (lo cubre el grafo). Anti-criterio: nada de estado transitorio, lo obvio del código, ni docs
reformuladas. Test de captura: "¿un dev/agente nuevo perdería tiempo o repetiría un error sin esto?".

## Tipos
| Tipo | Qué captura | Frescura |
|---|---|---|
| decision | elección de arquitectura/diseño + rationale + alternativas descartadas | TTL; puede quedar superseded |
| constraint | regla/invariante dura + alcance + consecuencia de violarla | revalida; alto valor → juez estricto |
| gotcha / bug-fix | bug no obvio + causa raíz + fix + cómo evitarlo | no suele caducar |
| pattern / convention | la forma establecida de hacer algo | revalida ocasional |
| integration-note | comportamiento/rareza de un sistema o API externa + workaround | caduca si cambia el proveedor |
| domain-rule | invariante de negocio + dónde se enforcea | revalida con el negocio |
| outcome | qué pasó después de una decisión (resultado observado) | histórico, no caduca |

## Forma del registro (estructurado)
Campos comunes: `type`, `title` (≤120), `summary` (una línea, ≤200), `body` (markdown, ≤2000), `fields` (jsonb,
campos por tipo), `date`, `refs`/`origin` (branch + PR). Campos por tipo en `fields`: decision→alternatives/drivers,
constraint→rule/scope/consequence, gotcha→symptom/root_cause/fix, integration→system/quirk/workaround,
domain-rule→rule/enforced_in, outcome→about/result/metrics, pattern→statement/applies_to.
Los límites de longitud van como CHECK en la DB → un registro nunca es tan grande como para que recall lo corte.

## Idioma: SIEMPRE inglés
Toda memoria se guarda en inglés, aunque la conversación sea en español. Es **regla del skill** (el agente
redacta en inglés), no traducción server-side. Consecuencia: FTS conviene `english` (stemming) sobre `simple`
— **a confirmar**.

## Búsqueda híbrida
Combina dos métodos (ninguno solo alcanza):
- **Léxica/full-text (BM25):** tsvector + ts_rank. Fuerte con identificadores/términos exactos; débil con sinónimos.
- **Semántica/vectorial (pgvector):** por significado. Fuerte con lenguaje natural; débil con identificadores.
- **Híbrida:** corre ambas y fusiona rankings (Reciprocal Rank Fusion) + time-decay + filtros por tipo/status.
Fases: arrancar léxica (ya en el esquema: tsvector+GIN), sumar semántica con pgvector; la interfaz no cambia.

## Alcance (repo → proyecto)
- 1 repo: buscar el repo = buscar el proyecto.
- N repos (default, escalonado): primero el repo actual (con boost) y después todo el proyecto.
- Modos configurables: `scope=repo` / `scope=project`. Se apoya en el filtro repo_id/project_id del esquema.

## TTL propuesto (revalidación)
constraint/decision 180d · domain-rule 365d · gotcha/pattern/integration-note 365d · outcome nunca. **A confirmar.**
