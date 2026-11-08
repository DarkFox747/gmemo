# Proposal: governance-web (C7) — TT-08, Figures 12–16

## Intent
The tech lead governs project memory from a web UI: the review queue, review detail, quarantine, project memory and a read-only administration view. It consumes the `/api/v1` endpoints from C2–C5 and is served by Express in development (`WEB_STATIC_DIR`).

## Scope

### In Scope
1. `packages/web` (`@gmemo/web`): React + Vite + TypeScript. **No** router, UI library or state library: hash routing, a typed `fetch` client for `/api/v1`, plain CSS. Dependencies are added by the human (react, react-dom; dev: vite, @vitejs/plugin-react, @types/react, @types/react-dom).
2. Mockup layout (`../figuras-entrega2/pantalla1..5.png`):
   - dark sidebar with the brand `crombie. memoria` and the subtitle "Memoria compartida y gobernada";
   - nav: Cola de revisión (pending badge), Memoria del proyecto, Cuarentena (badge), Administración;
   - project selector at the top; role and avatar on the right;
   - in development, a user selector (líder técnico / colaborador / lector) that sends `X-Dev-User`.
   - UI terminology: "Juez", never "evaluador".
3. Screens:
   1. **Cola de revisión** (Fig. 12): 4 counters; filters Todas / Dudosas / Revisión obligatoria / Decisiones / Restricciones; table (Tipo chip, Título, Motivo, Confianza bar, Origen `rama · PR n`, Autor, Fecha, Revisar).
   2. **Detalle de revisión** (Fig. 13): breadcrumb, metadata, content and type fields, reject reason (required on reject); Aprobar e incorporar / Rechazar y enviar a cuarentena / Posponer; Veredicto del juez card (state, criterion, confidence vs threshold, justification, mandatory); Unidad relacionada card with the "Marcar la unidad relacionada como reemplazada" checkbox. A 409 shows a clear message.
   3. **Cuarentena** (Fig. 14): filters Todas / Datos sensibles / Instrucciones embebidas / Duplicación / Rechazo del líder técnico; table (Motivo, Unidad, Extracto monospace with `[REDACTADO]`, Ingreso, Vence en, Ver, Restaurar); restore result in a toast. Footer: "Las restauraciones se registran como etiquetas para medir los falsos negativos del juez."
   4. **Memoria del proyecto** (Fig. 16): tabs Activas / Pendientes de revalidación; type filter and search; add/edit form with type-specific fields that previews first (shows the judge verdict) then confirms; retire with reason; confirm or retire pending; version history; bulk retire by PR.
   5. **Administración** (Fig. 15): read-only project, repos, members with role, service credentials without secrets (`/api/v1/me` + project info; a minimal read endpoint if needed).
4. Clear error messages; empty and loading states; basic accessibility (labels, focus, contrast). Every server text (titles, bodies, judge justification) is rendered as text, never as HTML (stored-XSS defence, C1 R1-SEC8).
5. Vitest tests for the API client and pure functions (formatters, type/status → Spanish labels).
6. Integrated build: `pnpm --filter @gmemo/web build`. The Dockerfile builds the web and copies `dist` into the image; compose sets `WEB_STATIC_DIR`, so `docker compose up --build` serves the web at `http://localhost:3000/`.

### Out of Scope
Real Cognito login/PKCE, admin CRUD of projects, repos and members, i18n beyond Spanish UI, mobile layout.

## Decisions
- D1: if Administración needs data beyond `/me` (repos, members, credentials), add one read-only `GET /api/v1/projects/:projectId/admin-summary` (project_admin) with no secrets.
- D2: the web is built inside the existing Docker image (multi-stage), so the demo stays a single `docker compose up --build`.

## Risks
| Risk | L | Mitigation |
|---|---|---|
| Blocked on dependencies | High | Ask the human early; C7 apply waits |
| Docker build complexity with the workspace | Med | Separate web build stage; frozen lockfile |
| XSS via memory content | Low | React text rendering only; no `dangerouslySetInnerHTML` (lint rule/test) |

## Rollback Plan
Revert the commit; the server is unaffected without `WEB_STATIC_DIR`.

## Success Criteria
- [ ] All five screens work against compose with seed data at 1440×900 with no console errors; client and pure-function tests green; compose serves the web at `/`.
