# 03 · Identidad, autenticación y autorización

## El MCP server NO es el Authorization Server
Es un **Resource Server**: valida tokens y anuncia el discovery. El que emite tokens es **Cognito**.
La restricción NO vive en la config del cliente (Claude) — eso no es una frontera de seguridad.

## Dos compuertas (se necesitan las dos)
- **Compuerta A — quién obtiene un token (Cognito):** user pool federado a Google Workspace, sign-up
  propio deshabilitado, y un **Lambda Pre-Sign-up/Pre-Token** que rechaza todo email fuera de `@<COMPANY_DOMAIN>`
  o de la allowlist. (Cognito no filtra dominio solo con mapping — el Lambda lo garantiza.)
- **Compuerta B — quién está autorizado (el server):** el JWT válido **no alcanza**; el `sub` tiene que
  mapear a un `app_user` provisionado con membresía. Si no existe/está disabled → 403. Después, RBAC por proyecto.

## Validación del token (middleware, cada request)
Verifica firma contra el **JWKS de Cognito**, valida `iss`, `token_use=access`, `exp`, `client_id` ∈ allowlist,
y el `scope` requerido. **Detalle Cognito:** el access token **no trae `aud`** (trae `client_id` + `scope`);
por eso se valida `client_id`, no `aud`. El filtro de dominio va en Cognito (el access token tampoco trae email).

## Tres flujos de identidad
| Principal | Flujo | Notas |
|---|---|---|
| Dev interactivo | OAuth 2.1 + PKCE (Cognito→Google WS) | corre como la persona |
| Agente headless | service principal / client_credentials | scoped por proyecto, revocable, TTL corto |
| CI / ingestión | OIDC → rol IAM efímero | restringido por claim del repo/branch |

Nota: Atenea en la laptop del analista corre como **el analista** (su token de usuario), no como service principal.

## RBAC multi-tenant
Cognito autentica + carga el **rol global** en un claim. La **membresía fina** (user × project × role) vive
en una **tabla de authz en RDS**, consultada por el facade en cada request. NO modelar la membresía como
grupos de Cognito (explotan, inflan el token, tienen límites). Aislamiento por proyecto enforced en el server.

Roles: **Platform Owner** (global, ownership), **Platform Admin** (global, ops/provisión),
**Project Admin** (un proyecto; curación), **Contributor** (read+stage), **Viewer** (read),
**Service/Agent** (read+stage, máquina).

**Cambio importante (provisión por ticket):** el owner del módulo es un **sysadmin** de la empresa. Alta de
personas, repos, permisos y proyectos se hace por **ticket en un sistema interno**. Se parte el RBAC en dos
planos: **provisión** (Platform Owner/Admin, gatillada por ticket) y **curación** (Project Admin en la Web UI).
Pendiente: definir si el sistema de tickets ejecuta por API o el sysadmin ejecuta a mano tras aprobar.

## Proyectos y multi-repo
El **proyecto** es la unidad de acceso y de partición de memoria; agrupa 1..N repos. Membresías a nivel
proyecto (un miembro ve todos los repos del proyecto). El grafo es multi-repo nativo (edges CROSS_*).
Regla: el límite del proyecto se dibuja por **sensibilidad/acceso**, no por prolijidad lógica.
