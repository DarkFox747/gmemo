# @gmemo/web — web de gobierno

React + Vite + TypeScript, sin router, librería de UI ni de estado: rutas por hash, un cliente `fetch`
tipado para `/api/v1` (`src/api/client.ts`, DTOs espejados a mano en `src/api/types.ts`) y CSS plano
(`src/styles.css`). Interfaz en español; el juez se llama siempre "Juez".

Pantallas (rutas hash):

| Pantalla                                        | Ruta                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| Inicio (ruta por defecto)                       | `#/home`                                                          |
| Cola de revisión                                | `#/review`                                                        |
| Detalle de revisión                             | `#/review/<itemId>`                                               |
| Área de preparación                             | `#/staging`                                                       |
| Memoria del proyecto                            | `#/memory`, `#/memory/new`, `#/memory/<id>`, `#/memory/<id>/edit` |
| Buscar como agente                              | `#/search`                                                        |
| Cuarentena                                      | `#/quarantine`, detalle `#/quarantine/<id>`                       |
| Actividad                                       | `#/activity`                                                      |
| Administración (solo lectura para project_admin)| `#/admin`                                                         |

Capturas en [`docs/demo/capturas/`](../../docs/demo/capturas/) (1–10).

## Scripts (desde la raíz del repo)

| Script               | Qué hace                                                                  |
| -------------------- | ------------------------------------------------------------------------- |
| `pnpm dev:web`       | Vite en http://localhost:5173 con proxy de `/api` a http://localhost:3000 |
| `pnpm build:web`     | build a `packages/web/dist`                                               |
| `pnpm typecheck:web` | `tsc` sobre la web (Vite transpila pero no type-chequea)                  |
| `pnpm test -- --run` | incluye `packages/web/src/**/*.test.ts` (cliente y funciones puras)       |

El server debe correr con `AUTH_DEV_BYPASS=true` (compose ya lo hace). Con `docker compose up --build` la web
se sirve directamente en http://localhost:3000/.

## Usuario de desarrollo

La barra superior tiene un selector _Usuario de desarrollo_ (`tl@`, `dev@`, `viewer@demo.local`) que se envía
como `X-Dev-User`; el server lo ignora en producción. Usuario y proyecto se guardan en `localStorage`
(`gmemo.devUser`, `gmemo.projectId`) y se validan al leerlos. No se guardan tokens ni se envía `Authorization`.

## Reglas

- Todo texto del servidor se renderiza como texto: prohibido `dangerouslySetInnerHTML`, `innerHTML` y afines
  (regla ESLint + `src/security.test.ts`).
- Nada inline en el HTML (CSP `script-src 'self'; style-src 'self'`); las URLs de datos nunca van a `href`.
