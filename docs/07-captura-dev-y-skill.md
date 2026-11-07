# 07 · Modelo de captura del dev (skill del coding agent)

## Modelo final (decidido, simple)
- El **orchestrator agent** tiene lectura (`recall`/`get_context`) y escritura (`remember`).
- **Directo a cloud, sin buffer local** para el piloto: sube las memorias de a una al MCP a medida que aparecen.
  (Los `remember` son infrecuentes → el round-trip no molesta. Si más adelante duele latencia/offline, se suma
  buffer local **en el home dir**, nunca en el repo.)
- **Híbrido activo** (por ahora): el agente decide cuándo `remember`, con barra alta.
- El *cuándo* lo dan los **pasos del SDD/OpenSpec** (no captura al azar). ← FALTA: las fases concretas del SDD
  para anclar las llamadas.
- **Todo en inglés** (regla del skill).
- Calidad sostenida por: criterio del skill + dedup + juez en la promoción.
- **Caveat:** sin barrido de cierre, lo que el agente no capture en el momento se pierde. Aceptable; el anclaje
  al SDD lo mitiga. Si se escapa conocimiento en el uso real, se suma un barrido después.

## Lectura vs escritura (por qué no delegar)
- **READ:** siempre el main agent, directo. Delegar dobla tokens (pasás contexto para la query + traés
  resultados de vuelta) y el delegado no tiene el contexto del repo. Cero delegación en lectura.
- **WRITE:** el handoff per-memory mid-flow es anti-patrón (N round-trips, interrumpe, dobla tokens).

## Librarian — DESCARTADO (para el piloto)
Se evaluó un sub-agente "librarian" para manejar la memoria. Conclusión: **no se justifica**. El único modelo
donde pagaría era como **curador batch de cierre** (una pasada al final con transcript+diff). Pero el autor decidió
mantenerlo simple: el orchestrator hace `remember` de a una y listo — casi gratis porque ya tiene el contexto.
Queda como opción futura (barrido de cierre) si se ve pérdida de conocimiento.

## Hallazgos de engram (referencia para la captura)
Verificado en el README real:
- Captura híbrida: `mem_save` (activo, "al completar trabajo significativo") + `mem_capture_passive` (pasivo).
- Ciclo de sesión: `mem_session_start/summary/end` con **compaction survival** (la memoria sobrevive a la
  compactación del contexto de Claude Code). Idea a robar para el skill (get_context al inicio; summary al cerrar).
- Conflicto en el save (`candidates[]`) + `mem_judge` (LLM). Confirma nuestro juez.
- engram persiste local en `~/.engram/engram.db` (home dir, NO en el repo) y comparte con `engram sync` explícito.
- Estructura What/Why/Where/Learned + topic keys.

## Atenea — DIFERIDA (dejada de lado por ahora)
Atenea (crombie-analyst) corre en la laptop del analista y **no necesariamente trabaja sobre una rama** → rompe
la clave de sesión (project,repo,branch) y el trigger de promoción por merge.
Diseño propuesto cuando se retome (NO implementar aún): misma LPMS (no base separada, para no fragmentar), pero
con **ancla de confianza = revisión humana** (cola Web UI, sin merge), **scope = proyecto** (no branch),
provenance `atenea`, destilar solo conocimiento durable (los PRDs crudos van a Jira/.docs), e identidad = el token
del analista (en su laptop) o service principal (headless). Si hace falta aislar, partición lógica en la misma
RDS, no base física. Alinear con el skill `lpms-convention` del plugin de analista.
**Estado: fuera de alcance del piloto; foco full en el dev.**
