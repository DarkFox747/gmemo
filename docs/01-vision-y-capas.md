# 01 · Visión y modelo de dos capas

## Objetivo de negocio
LPMS hoy es un MCP local (SQLite) por dev: le da memoria persistente por proyecto a los agentes
(Claude Code, Cowork, Atenea), pero al ser local **el conocimiento no se comparte**. El objetivo es
llevarlo a un servicio compartido en AWS para: (a) compartir el conocimiento tácito entre devs y
agentes, (b) mejorar los resultados de los agentes con contexto histórico + estructural, y
(c) gobernar el contenido contra poisoning y staleness.

## Modelo de dos capas (NO se fusionan)
Difieren en las dos dimensiones que gobiernan el diseño: **confianza** y **frescura**.

| Eje | Layer 1 — Decisiones (LPMS) | Layer 2 — Grafo de código |
|---|---|---|
| Naturaleza | Aserción humana/agente (el porqué) | Derivada del código (el qué/dónde) |
| Confianza | Baja → gobernanza fuerte | Reproducible → sin gobernanza |
| Frescura | Se pudre → TTL + revisión | Auto-reindex → nunca stale |
| Almacén | RDS Postgres centralizado | Grafo cloud (construido por CI del repo) |

Se unifican en la **capa de orquestación** (el facade MCP), y en fase posterior por **cross-link**
decisión↔símbolo. Nunca en una base común.

**Por qué no fusionar:** meterle a la memoria derivada (grafo) la misma gobernanza que a la asertada
(decisiones) es esfuerzo perdido en una y dilución de controles en la otra.

## Referencias: engram vs codebase-memory-mcp
Se evaluaron dos repos que inspiran el diseño (comparación completa en `artefactos/`):
- **engram** (Gentleman-Programming): memoria de decisiones, MISMA categoría que LPMS. Go + SQLite +
  FTS5, 19 tools, What/Why/Where/Learned, ciclo de sesión, conflict-judge (LLM), git-sync. **Local-first**.
- **codebase-memory-mcp** (DeusData): grafo de código estructural (tree-sitter), otra categoría (Layer 2).

**Decisión:** NO adoptar engram tal cual (su modelo local-first pelea con nuestro centralizado/gobernado);
usarlo como **referencia** y robar ideas (captura híbrida activo+pasivo, ciclo de sesión + compaction
survival, conflict-judge de 3 estados, plantilla What/Why/Where/Learned). LPMS ya está más adelante en
gobernanza. codebase-memory-mcp se adopta casi tal cual como Layer 2 (grafo multi-repo con edges CROSS_*).
