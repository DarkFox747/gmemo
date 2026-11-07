# 09 · Decisiones abiertas y próximos pasos

## Confirmaciones rápidas pendientes (rulear para avanzar)
- **FTS `english`** (dado que guardamos todo en inglés) vs `simple`. → propuesto: `english`.
- **Cuarentena: 1 o 2 meses** de retención.
- **Fases del SDD/OpenSpec** de Crombie — necesarias para anclar `recall`/`remember` en el skill del dev.
- **Sistema de tickets:** ¿ejecuta la provisión por API, o el sysadmin la ejecuta a mano tras aprobar?
- **Build del grafo:** confirmar subida por **URL prefirmada a S3** y si proveemos el **template de workflow** con cbm.

## A verificar (afecta el borde)
- **AgentCore Gateway:** ¿sostiene el streaming SSE largo de MCP sin cortes? ¿precio? (define ALB vs AgentCore).

## Bloquean el piloto
- **Onboarding proyecto↔repo** operativo (ver 08).
- **Contenido del skill del coding agent** (falta las fases del SDD).
- Las confirmaciones rápidas de arriba.

## Para producción
- **Spec funcional de la Web UI:** cola de revisión, vista de merge de conflictos (#7), cuarentena, admin de
  proyectos/roles/keys, visor de auditoría, viz del grafo.
- **Entrega de notificaciones:** Web UI (log de rechazos) + ¿email/Slack?
- **Rate limiting / control de costo:** cuotas por principal/proyecto; tope del juez (LLM).
- **Políticas de retención y auditoría** (compliance).
- **Región / residencia de datos.**
- Ajustes de esquema para prod (ver 06): idempotencia por item, `partially_promoted`, tabla `quarantine`, FTS `english`.

## Diferido (no bloquea)
- **Atenea** (ver 07) — fuera del piloto.
- **Búsqueda semántica** (pgvector) — fase posterior.
- **Cross-link decisión↔símbolo** (Layer 1 ↔ Layer 2).
- **Buffer local** home-dir (solo si duele latencia/offline).
- **Librarian** como barrido de cierre (solo si se pierde conocimiento).

## Orden de build sugerido
1. Modelo de datos (hecho: v2). 2. Contrato del facade (hecho). 3. Staging + pipeline de promoción (diseño cerrado).
4. Onboarding + identidad de máquina. 5. Skill del coding agent. 6. Piloto (Fase 0).
