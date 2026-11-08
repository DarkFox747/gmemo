# Design: Governance web (C7) — TT-08, Figures 12–16

## Technical Approach

C7 turns the manifest-only workspace package `packages/web` (`@gmemo/web`) into a React + Vite + TypeScript single-page app. It uses only the approved dependencies: `react` and `react-dom`, plus the dev dependencies `vite`, `@vitejs/plugin-react`, `@types/react` and `@types/react-dom`. `typescript` and `vitest` already sit at the root. There is no router, UI kit or state library. The app is built from these pieces:

- **Hash routing**: one pure parser (`lib/hashRoute.ts`) and one `useHashRoute` hook.
- **Typed `fetch` client** (`api/client.ts`) for the `/api/v1` endpoints that C2–C5 define, plus one new read endpoint. Its DTO types (`api/types.ts`) are a hand-kept mirror of `src/http/api/types.ts`.
- **Per-screen state**: `useState`/`useEffect` through one small `useAsync` hook, a React-context toast, and native `<dialog>` for confirmations.
- **Plain CSS**: `styles.css` with design tokens taken from the mockups.

The server side changes in only one place. Proposal D1 adds one read-only endpoint, `GET /api/v1/projects/:projectId/admin-summary` (project_admin, no secrets), on C2's nested project router. It follows the C2–C5 pattern exactly: a repository, a thin route, `recordApi` after success, and the uniform 404.

Serving follows C2's `WEB_STATIC_DIR` design:
- **Development**: `pnpm --filter @gmemo/web dev` runs Vite on :5173 and proxies `/api` to Express on :3000.
- **Demo**: `docker compose up --build` builds the web in its own Docker stage. Express serves `/app/web` under the strict HTML-only CSP from C2 (`script-src 'self'; style-src 'self'`). The web never uses inline script or style markup.

**Prerequisites**:
- C2–C5 must be implemented, or at least C2's `src/http/api/router.ts` and nested project router must exist, because batch B mounts on them.
- The human adds the dependencies out of band (`pnpm --filter @gmemo/web add react react-dom` and `pnpm --filter @gmemo/web add -D vite @vitejs/plugin-react @types/react @types/react-dom`) and commits `pnpm-lock.yaml`. Agents only run `pnpm install --frozen-lockfile`.

**Spec and mockup alignment notes (for the orchestrator)**:
- The Administración mockup shows edit controls ("Guardar cambios", "+ Agregar", "Quitar", role dropdowns) and a TICKET column. The proposal makes the screen **read-only** (admin CRUD is out of scope), and the schema has no ticket column. The screen therefore renders the same cards with no edit controls and no ticket column.
- Mockup text "evaluador" becomes **"Juez"** everywhere: "Dudosas del Juez", "Veredicto del Juez", and the quarantine footer "…falsos negativos del Juez."
- "Resueltas esta semana" is backed by C2's `resolvedLast7Days`, so the label reads "Resueltas (últimos 7 días)" to stay accurate.
- "Posponer" has no API. It returns to the queue and leaves the item untouched. A toast says so.

## Architecture Decisions

### Decision: Package layout and tooling — one root toolchain, web-local Vite config

**Choice**:

```
packages/web/
  package.json          scripts: dev = "vite", build = "vite build"  (+ deps added by the human)
  index.html            <link rel="icon" href="/favicon.svg">, <link>-free, one <script type="module" src="/src/main.tsx">
  public/favicon.svg    avoids a /favicon.ico 404 console error
  vite.config.ts        plugin-react; server.port 5173; server.proxy {'/api': 'http://localhost:3000'};
                        build { outDir: 'dist', emptyOutDir: true, modulePreload: { polyfill: false } }
  tsconfig.json         target ES2022, lib [ES2022, DOM, DOM.Iterable], module ESNext, moduleResolution Bundler,
                        jsx react-jsx, strict, noEmit, isolatedModules, types ["vite/client"], include ["src"]
  src/main.tsx  src/App.tsx  src/styles.css
  src/api/{client.ts, types.ts}
  src/lib/{format.ts, labels.ts, hashRoute.ts, storage.ts, useAsync.ts}
  src/components/*.tsx  src/screens/*.tsx
```

Root `package.json` scripts:

| Script | Command |
|---|---|
| `dev:web` | `pnpm --filter @gmemo/web dev` |
| `build:web` | `pnpm --filter @gmemo/web build` |
| `typecheck:web` | `tsc -p packages/web/tsconfig.json` |
| `lint` | `eslint src tests scripts packages/web/src packages/web/vite.config.ts` |

The full verification line becomes `pnpm build && pnpm typecheck:web && pnpm build:web && pnpm test -- --run && pnpm lint`.

- **Tests**: the root `vitest.config.ts` `include` gains `'packages/web/src/**/*.test.ts'`. One runner, one `pnpm test`, one environment (`node`).
  - Web tests cover only pure functions and the client. The client takes an injected `fetch`, and Node 22 provides `Response`/`Headers`. Storage is injected as a `Storage`-like object.
  - There are no component tests, because jsdom and testing-library are not approved dependencies.
- **Type checking**: run from the root with the root `typescript`. The web `build` script stays `vite build`, so it never depends on a `tsc` binary inside the web package. Vite transpiles but does not type-check, so `typecheck:web` is the gate.
- **ESLint**: the root flat config already lints `.ts`/`.tsx` through `typescript-eslint`, which infers JSX from the file extension. It gains a `packages/web/**` block (see the XSS decision) and `ignores: ['packages/web/dist/**']`. No React ESLint plugins are added (not approved).
- **Root `tsconfig.json`**: unchanged (`rootDir: src`). The server build never sees web code.

**Alternatives considered**:
- (a) A web-local `vitest.config.ts` plus `vitest` as a web dev dependency. Rejected: not an approved dependency, and it would make two test commands.
- (b) `tsc && vite build` inside the web package. Rejected: it relies on pnpm exposing the root `.bin` to the workspace package, and the root script is unambiguous.
- (c) Project references from the root tsconfig. Rejected: they change the server build for no benefit.

**Rationale**: It keeps the `build/test/lint` triad the repo already uses and adds only explicit, root-runnable steps.

**Reversible**: Yes.

### Decision: DTO types are a hand-kept mirror, not imported from the server

**Choice**: `packages/web/src/api/types.ts` re-declares exactly the JSON shapes it consumes, with a header comment naming each source file and section:
- From C2: `MeDto`, `ReviewQueue*`, `ReviewItemDetailDto`, `MemoryRefDto` (with C4's widened `status`), `Approve/RejectResponseDto`, `ApiErrorBody`, `ConflictCode`.
- From C3: `Quarantine*Dto`, `RestoreResponseDto`.
- From C4 and C5: the `Memory*Dto` types, `ConfirmResponseDto`, `RetireResponseDto`, `RetireByPrResponseDto`, `PreviewResponseDto`, `DirectWriteResponseDto`.
- From this change: `AdminSummaryDto`.
- Literal unions as `as const` arrays: `MEMORY_TYPES`, `MEMORY_STATUSES`, `QUARANTINE_REASON_CODES`, `DECISION_CRITERIA`, `PROJECT_ROLES`. The label maps are typed `Record<Union, string>`, so a missing label is a compile error.

**Alternatives considered**:
- (a) Import `src/http/api/types.ts` by relative path. Rejected: that file imports `express` and server modules, it would pull server code into the browser type graph, and the Docker web stage would need `src/`.
- (b) A shared `packages/contracts` package. Rejected (YAGNI): it is a new module plus a restructure of the server imports for one consumer.

**Rationale**: The web consumes about twenty plain JSON shapes. A mirror is small and explicit.
- **Drift risk**: the server is the moving side.
- **Mitigation**: client tests use fixtures copied from the C2–C5 design DTO blocks, and the compose smoke catches the rest.

**Reversible**: Yes. It can be replaced by a shared package later without changing call sites.

### Decision: Typed client — one factory, injected `fetch`, dev user header, error mapping to user messages

**Choice** (`src/api/client.ts`):

```ts
export type ApiErrorKind = 'unauthorized' | 'not_found' | 'invalid' | 'conflict' | 'rate_limited' | 'server' | 'network';
export class ApiError extends Error {
  constructor(readonly kind: ApiErrorKind, readonly status: number | null, readonly conflictCode?: ConflictCode) { super(kind); }
}
export interface ApiClientDeps { fetchFn: typeof fetch; getDevUser: () => string | null; }
export function createApiClient(deps: ApiClientDeps): ApiClient;
export function errorMessage(err: unknown): string;     // Spanish, user-facing; never echoes server text

export interface ApiClient {
  getMe(): Promise<MeDto>;
  listReviewQueue(p: string, q: { filter: QueueFilter; type?: MemoryType; limit?: number }): Promise<ReviewQueueListDto>;
  getReviewItem(p: string, itemId: string): Promise<ReviewItemDetailDto>;
  approveReviewItem(p: string, itemId: string, b: { markRelatedSuperseded: boolean; targetRevision?: number }): Promise<ApproveResponseDto>;
  rejectReviewItem(p: string, itemId: string, b: { reason: string }): Promise<RejectResponseDto>;
  listQuarantine(p: string, q: { reason?: QuarantineReasonCode; limit?: number }): Promise<QuarantineListDto>;
  getQuarantineItem(p: string, id: string): Promise<QuarantineDetailDto>;
  restoreQuarantineItem(p: string, id: string): Promise<RestoreResponseDto>;
  listMemories(p: string, q: { status: MemoryStatus; type?: MemoryType; q?: string; cursor?: string; limit?: number }): Promise<MemoryListDto>;
  getMemory(p: string, id: string): Promise<MemoryDetailDto>;
  previewMemory(p: string, b: PreviewRequest): Promise<PreviewResponseDto>;
  createMemory(p: string, b: CreateMemoryRequest): Promise<DirectWriteResponseDto>;   // confirm: true
  amendMemory(p: string, id: string, b: AmendMemoryRequest): Promise<DirectWriteResponseDto>; // expectedRevision, confirm: true
  confirmMemory(p: string, id: string): Promise<ConfirmResponseDto>;
  retireMemory(p: string, id: string, b: { reason: string }): Promise<RetireResponseDto>;
  retireByPr(p: string, b: { originPr: number; reason: string }): Promise<RetireByPrResponseDto>;
  getAdminSummary(p: string): Promise<AdminSummaryDto>;
}
```

- **URLs**: `/api/v1/...`, relative and same-origin. Every path segment goes through `encodeURIComponent`. Queries use `URLSearchParams`, which drops `undefined` and empty strings, so the server's `.strict()` zod never sees stray keys.
- **Request options**: `cache: 'no-store'` and `Accept: application/json`. Bodies are `JSON.stringify` with `Content-Type: application/json`. POSTs with no payload (`confirm`, `restore`) send `{}`.
- **Authentication**:
  - **`X-Dev-User`** is sent only when `getDevUser()` returns a value. The client sends **no `Authorization` header and stores no tokens**, so there are no secrets in the bundle or in storage. Real Cognito/PKCE login is out of scope.
  - The server ignores `X-Dev-User` in production through C2's three-layer guard.
- **Error mapping**:
  - Status codes: 401 → `unauthorized`, 404 → `not_found`, 400 → `invalid`, 429 → `rate_limited`, ≥ 500 → `server`.
  - 409 → `conflict` with `conflictCode` only if the body's `code` is one of the known `ConflictCode` values.
  - A `fetch` rejection → `network` (status `null`).
  - A 2xx with a non-JSON body → `server`.
  - Error bodies are read only for the 409 `code`. Server `error` strings are never shown.
- **`errorMessage`** (Spanish text lives in `lib/labels.ts`):
  - 401: "No se pudo identificar al usuario. Revisa el usuario de desarrollo seleccionado."
  - 404: "No se encontró el elemento o no tienes acceso a él." This is opaque by design, matching the server's opacity.
  - 400: "Los datos enviados no son válidos. Revisa el formulario."
  - 429: "Demasiadas solicitudes. Espera un momento y vuelve a intentarlo."
  - 5xx: "Error del servidor. Inténtalo de nuevo más tarde."
  - Network: "No hay conexión con el servidor."
  - `target_changed`: "La unidad destino cambió desde que abriste la revisión. Recarga para ver la versión actual."
  - `target_inactive`: "La unidad destino ya no está activa."
  - `duplicate_content`: "Ya existe una unidad con el mismo contenido. Puedes rechazar esta propuesta."
- The instance is created once in `main.tsx` (`createApiClient({ fetchFn: window.fetch.bind(window), getDevUser: () => storage.getDevUser() })`) and passed down as a prop (`api`). There is no global singleton, so tests construct their own.

**Alternatives considered**:
- (a) Per-endpoint free functions calling global `fetch`. Rejected: they are hard to test without patching globals.
- (b) Showing the server's `error` string. Rejected: it is English, and opaque on purpose.

**Rationale**: One typed seam. Each test can assert the exact URL, method, headers and body, and every error mapping row.

**Reversible**: Yes.

### Decision: Dev user selector and project selection persisted in `localStorage`, validated on read

**Choice** (`src/lib/storage.ts`):

```ts
export const DEV_USERS = [
  { email: 'tl@demo.local', label: 'Líder técnico' },
  { email: 'dev@demo.local', label: 'Colaborador' },
  { email: 'viewer@demo.local', label: 'Lector' },
] as const;
export function createStorage(s: Pick<Storage, 'getItem' | 'setItem'>): {
  getDevUser(): string;           // stored value if ∈ DEV_USERS, else 'tl@demo.local'
  setDevUser(email: string): void; // ignores values not in DEV_USERS
  getProjectId(): string | null; setProjectId(id: string): void;
};
```

- Keys are `gmemo.devUser` and `gmemo.projectId`. Storage is untrusted input: values outside the allowlist are ignored, and a stored project id is used only if it appears in `/me` `projects`. Otherwise the first project is used.
- `localStorage` access is wrapped in try/catch. A blocked storage throws `SecurityError`; the wrapper logs `console.warn` and falls back to defaults, so the failure is handled, not silent.
- The selector (labelled `<select>` "Usuario de desarrollo") lives in the top bar and is always rendered. The bundle is only served by dev Express (`WEB_STATIC_DIR` is prod-guarded) or by Vite. A future production host would drop it together with adding real login (out of scope).
- Changing the user or project resets screen state: `App` remounts the screen with `key={devUser + projectId}` and reloads `/me` and the badges.

**Alternatives considered**: a build-time flag `VITE_DEV_LOGIN`. Rejected (YAGNI): there is no production web host yet, and the server already neutralises the header in production.

**Reversible**: Yes.

### Decision: Hash routes

**Choice** (`src/lib/hashRoute.ts`, pure and tested):

```ts
export type Route =
  | { name: 'review' } | { name: 'reviewDetail'; itemId: string }
  | { name: 'memory' } | { name: 'memoryNew' } | { name: 'memoryDetail'; memoryId: string } | { name: 'memoryEdit'; memoryId: string }
  | { name: 'quarantine' } | { name: 'quarantineDetail'; id: string }
  | { name: 'admin' };
export function parseHash(hash: string): Route;   // unknown/empty → { name: 'review' }; ids must match a UUID regex, otherwise → list route
export function buildHash(r: Route): string;      // '#/review', '#/review/<id>', '#/memory/new', '#/memory/<id>/edit', ...
export function useHashRoute(): Route;            // hashchange listener; navigate via location.hash = buildHash(r)
```

- The project is **not** in the URL. It is App state persisted by `storage`. This keeps routes stable across user switching.
- After each route change, focus moves to the screen `<h1 tabIndex={-1}>` for screen readers.

**Alternatives considered**: History API paths. Rejected: they need extra handling (C2's SPA fallback would work, but Vite's dev proxy and deep-link refreshes add moving parts). Hash routing has none, and the proposal names it.

**Reversible**: Yes.

### Decision: State approach — `useAsync` per screen, App-level shell state, context only for toasts

**Choice**:
- `src/lib/useAsync.ts`: `useAsync<T>(fn: () => Promise<T>, deps): { status: 'loading'|'ready'|'error'; data?: T; error?: unknown; reload(): void }`. It ignores stale responses with an effect-scoped `cancelled` flag. All eight screens use it, so the extraction is justified.
- **`App.tsx` owns the shell state**:
  - `me` and `meError`, the selected `projectId`, and the derived `role` (the membership role of the selected project).
  - `badges: { review: number | null; quarantine: string | null }`, with a `refreshBadges()` callback that screens call after a write.
  - The badges load when the role is `project_admin`: `listReviewQueue(p, { filter: 'all', limit: 1 })` → `counters.pending`, and `listQuarantine(p, { limit: 200 })` → `items.length`, or `"200+"` when `truncated`. A badge load failure hides that badge and logs `console.error`. It never blocks the shell.
- `components/Toast.tsx`: `ToastProvider` + `useToast()` (React context). There is one `role="status" aria-live="polite"` region, and toasts auto-dismiss after 6 s.
- Writes are imperative: button → `setBusy(true)` → client call → toast + reload or navigate → `setBusy(false)`. Buttons are `disabled` while busy, which prevents double submits. Every failure goes to `errorMessage(err)` in an inline `role="alert"` message and to `console.error` for the developer.

**Alternatives considered**: `useReducer`/global store. Rejected: screens share almost nothing except the project, the role and the badges.

**Reversible**: Yes.

### Decision: XSS defence — React text rendering only, enforced by ESLint and a source-scan test

**Choice**:
- All server strings (titles, bodies, fields, judge justification, quarantine excerpts) are rendered as JSX text children.
  - `fields` values are rendered by `FieldsView`: strings as text, arrays joined with " · ", anything else as `JSON.stringify(v)` text.
  - URLs from data are never put in `href` (repo remote URLs are shown as monospace text).
- In `eslint.config.mjs`, a block for `files: ['packages/web/**/*.{ts,tsx}']` adds:

```js
'no-restricted-syntax': ['error',
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'Render server text as text (C1 R1-SEC8).' },
  { selector: "MemberExpression[property.name=/^(innerHTML|outerHTML)$/]", message: 'No HTML sinks.' },
  { selector: "CallExpression[callee.property.name=/^(insertAdjacentHTML|write|writeln)$/]", message: 'No HTML sinks.' }],
'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error',
```

- `packages/web/src/security.test.ts` walks `packages/web/src/**/*.{ts,tsx}` (excluding itself) with `node:fs` and fails on `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `eslint-disable` comments that mention `no-restricted-syntax`. This catches a lint suppression that a reviewer might miss.

**Alternatives considered**: a sanitizer such as DOMPurify. Rejected: it is not approved, and nothing needs HTML rendering.

**Reversible**: Yes.

### Decision: CSP compatibility

**Choice**:
- `index.html` has no inline `<script>` or `<style>` and no `style=` attributes. Vite's production build emits only `<script type="module" src="/assets/…js">` and `<link rel="stylesheet" href="/assets/…css">`. `modulePreload.polyfill: false` removes Vite's preload polyfill code; modern browsers do not need it.
- The only dynamic style is the confidence bar width. React applies `style={{ width }}` through the CSSOM (`element.style`), which `style-src 'self'` does not block. CSP restricts style *attributes in markup* and `setAttribute('style')`, not CSSOM writes. There is no SSR, so no `style=` attribute ever reaches the HTML.
- No external fonts or images: system font stack, `favicon.svg` from `public/`, and no `data:` assets beyond what `img-src 'self' data:` already allows.
- `connect-src 'self'` holds because every request is a relative `/api` request.
- Vite dev mode injects an inline React-refresh preamble. Express never serves the dev server, so dev mode has no CSP; this is expected and documented.

**Rationale**: It satisfies C2's `WEB_CSP` as written, with no relaxation.

**Reversible**: Yes.

### Decision: Admin summary read endpoint (proposal D1)

**Choice**: `/me` only lists the user's projects and roles. The Administración screen also needs repos, members and service credentials, so C7 adds:

```
GET /api/v1/projects/:projectId/admin-summary      (apiAuth → projectAdmin → handler → recordApi('admin_summary.read'))
```

```ts
// src/db/adminSummaryRepository.ts
export interface AdminSummaryRepository { getAdminSummary(projectId: string): Promise<AdminSummaryDto | null>; }
export class PgAdminSummaryRepository implements AdminSummaryRepository { constructor(pool: Pick<Pool, 'query'>) }
```

```sql
-- PROJECT (null → 404; archived → null)
SELECT id, slug, name, created_at FROM project WHERE id = $1 AND archived_at IS NULL
-- REPOS
SELECT id, remote_url, slug, provider, default_branch, created_at FROM repo WHERE project_id = $1 ORDER BY created_at, id
-- MEMBERS
SELECT u.id, u.email, u.display_name, pm.role, pm.granted_at, (u.disabled_at IS NOT NULL) AS disabled
FROM project_membership pm JOIN app_user u ON u.id = pm.user_id
WHERE pm.project_id = $1 ORDER BY pm.role, lower(COALESCE(u.display_name, u.email)), u.id
-- CREDENTIALS — explicit column list; token_hash is NEVER selected
SELECT id, principal_name, role, created_at, expires_at, revoked_at,
       CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at <= now() THEN 'expired' ELSE 'active' END AS status
FROM machine_credential WHERE project_id = $1 ORDER BY principal_name, id
```

```ts
interface AdminSummaryDto {
  project: { id: string; slug: string; name: string; createdAt: string };
  repos: Array<{ id: string; remoteUrl: string; slug: string | null; provider: string | null; defaultBranch: string; createdAt: string }>;
  members: Array<{ userId: string; email: string; displayName: string | null; role: ProjectRole; grantedAt: string; disabled: boolean }>;
  credentials: Array<{ id: string; principalName: string; role: ProjectRole; createdAt: string; expiresAt: string;
                       revokedAt: string | null; status: 'active' | 'expired' | 'revoked' }>;
}
```

- **Route**: `src/http/api/adminRoutes.ts` exports `makeAdminRoutes({ adminSummaryRepository, auditLogger })`. `router.ts` mounts it on C2's nested `/v1/projects/:projectId` router behind `projectAdmin`.
  - `null` → `AppError(NOT_FOUND)`.
  - The query string is not accepted: `z.object({}).strict()` on `req.query`, and failure → `INVALID_REQUEST` after `projectAdmin`, following C2's oracle rule.
- **Audit**: `ApiAction` gains `'admin_summary.read'` and maps to `read` (it is not in `WRITE_API_ACTIONS`). The audit detail is `{ resultCount: members.length }`, with no emails.
- **Opacity**: a non-admin, a non-member, a malformed id or a random id all get C2's byte-identical `{"error":"Not found"}`.
- **No secrets**: there is no `token_hash` in SQL, row types or DTOs. A unit test asserts the serialized response contains neither `token` nor the fake hash value.
- `ApiRouterDeps` gains `adminSummaryRepository: AdminSummaryRepository`. `src/index.ts` builds `new PgAdminSummaryRepository(pool)`.

**Alternatives considered**:
- (a) Add the reads to `AuthRepository`. Rejected: that is the Gate-2 seam used on every request, and admin listing is not authorization.
- (b) Four separate endpoints. Rejected (YAGNI): one screen, one read.
- (c) Open it to every member. Rejected: the proposal says project_admin, and member emails are personal data.

**Reversible**: Yes. It is an additive endpoint with no schema change.

### Decision: Docker — shared deps stage, parallel server and web build stages; compose sets `WEB_STATIC_DIR` (dev only)

**Choice** (`Dockerfile`):

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/web/package.json ./packages/web/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS builder                      # server — unchanged steps
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM deps AS web-builder                  # web — built in parallel by BuildKit
COPY packages/web ./packages/web
RUN pnpm typecheck:web && pnpm build:web

FROM node:22-alpine AS runtime            # unchanged except one COPY
...
COPY --from=web-builder /app/packages/web/dist ./web
```

- The image remains the single artefact (proposal D2). In production `/app/web` is inert, because `WEB_STATIC_DIR` is rejected under `NODE_ENV=production` by config and by `index.ts`. That costs about 300 KB.
- `pnpm prune --prod` runs only in `builder`, so web dev tooling never reaches the runtime `node_modules`.
- `.dockerignore`: after `packages/**` and `!packages/web/package.json`, add these lines in order:
  - `!packages/web/index.html`, `!packages/web/vite.config.ts`, `!packages/web/tsconfig.json`, `!packages/web/public/**`, `!packages/web/src/**`
  - then `packages/web/src/**/*.test.ts`, so tests stay out of the context.
- `docker-compose.yml`: `app.environment` gains `WEB_STATIC_DIR: /app/web` with the comment `# dev only — rejected under NODE_ENV=production (C2 guard)`. `migrate` is unchanged.

**Alternatives considered**:
- (a) Build the web inside `builder` before the prune. Rejected: `prune --prod` keeps the web's runtime deps in the shared `.pnpm` store, so the runtime image would grow, and the server and web builds would run sequentially.
- (b) A separate web image or nginx. Rejected by D2.

**Reversible**: Yes. Remove the stage and the COPY.

## Screens

Every screen uses the shell `Sidebar` + `TopBar`, an `<h1>`, a subtitle `<p>`, and `StateViews`:
- `Loading`: `aria-busy`, "Cargando…".
- `Empty`: per-screen copy.
- `ErrorMessage`: `role="alert"` + `errorMessage` + a "Reintentar" button.
- `NoAccess`: "Esta sección requiere el rol de líder técnico en el proyecto seleccionado."

Admin-only screens (review, memory, admin) render `NoAccess` without calling the API when `role !== 'project_admin'`. A 404 from the server, for example after a role change, renders the same view.

| Screen (route) | Components | API calls | Behaviour |
|---|---|---|---|
| **Cola de revisión** `#/review` (Fig. 12) | 4 `Counter` cards (Pendientes, Dudosas del Juez, Revisión obligatoria, Resueltas (últimos 7 días)); `FilterBar` (Todas / Dudosas / Revisión obligatoria / Decisiones / Restricciones, `aria-pressed`); table: `TypeChip`, Título, Motivo chip, `ConfidenceBar`, Origen `rama · PR n` (mono), Autor, Fecha, "Revisar" | `listReviewQueue(p, {filter, type})`. Filter map: Todas→`all`; Dudosas→`uncertain`; Obligatoria→`mandatory`; Decisiones→`all`+`decision`; Restricciones→`all`+`constraint` | Motivo: `mandatoryReview` → grey "Revisión obligatoria"; otherwise yellow "Dudosa · {criterionShort}". `truncated` → note "Se muestran las 100 más antiguas". Empty: "No hay unidades pendientes de revisión." |
| **Detalle de revisión** `#/review/:itemId` (Fig. 13) | Breadcrumb (`<nav aria-label="Ruta">` "Cola de revisión › Unidad propuesta"); title + `TypeChip` + meta "Propuesta por {author} · rama {branch} · PR {n} · {fecha}"; content card: Resumen, Desarrollo (body, `white-space: pre-wrap`), `FieldsView`; reject reason `<textarea>` (label "Motivo de rechazo (obligatorio si se rechaza)", 3–500); buttons; **Veredicto del Juez** card (state chip, Criterio determinante, Confianza bar + "umbral 0,80", Justificación, Revisión obligatoria Sí/No); **Unidad relacionada** card (`related` or `target`: type and status chips, title, "Versión n · origen PR m") + checkbox "Marcar la unidad relacionada como reemplazada" (shown only when `related` exists and the op is not `deprecate`) | `getReviewItem`; `approveReviewItem(p, id, {markRelatedSuperseded, targetRevision: op !== 'add' ? target?.version : undefined})`; `rejectReviewItem(p, id, {reason})` | `targetStale` → warning banner "La unidad destino cambió (versión actual n). Al aprobar se aplicará sobre esa versión." Reject with < 3 chars → inline field error, no call. Success → toast ("Aprobada e incorporada a la memoria" / "Rechazada y enviada a cuarentena"; `deduped` → "…ya existía una unidad idéntica"), `refreshBadges()`, navigate to `#/review`. **409** → `role="alert"` with the conflict message + "Recargar" (reloads detail). 404 → "Esta unidad ya fue resuelta o no existe." with a link back. Posponer → back to the queue + toast "Revisión pospuesta; la unidad sigue en la cola." |
| **Cuarentena** `#/quarantine` (Fig. 14) | `FilterBar` (Todas / Datos sensibles / Instrucciones embebidas / Duplicación / Rechazo del líder técnico → `secret_detected` / `embedded_instructions` / `duplicate_content` / `human_rejected`); table: Motivo (`ReasonChip` + criterion line), Unidad (`TypeChip` + title), Extracto (`<code>`, mono, shows `[REDACTADO]` as stored), Ingreso ("Hace n días"), Vence en ("n días" / "—"), "Ver", "Restaurar" (admin only); footer "Las restauraciones se registran como etiquetas para medir los falsos negativos del Juez." | `listQuarantine(p, {reason})`; `restoreQuarantineItem` | Visible to any member (C3 `projectMember`; non-admins see only their own items, a server rule). Restaurar → `ConfirmDialog` "Restaurar la unidad la vuelve a someter a sanitización y evaluación." Result toast: `applied` "Restaurada e incorporada a la memoria"; `queued` "Restaurada; quedó en la cola de revisión"; `quarantined` "El pipeline la volvió a enviar a cuarentena". Then reload + `refreshBadges()`. 404 → "No se puede restaurar esta unidad." |
| **Detalle de cuarentena** `#/quarantine/:id` | Breadcrumb; chips; summary, body (pre-wrap), `FieldsView`, judge reason (text), author, origin, expiry, related card; Restaurar if `canRestore && admin` | `getQuarantineItem`; `restoreQuarantineItem` | As above |
| **Memoria del proyecto** `#/memory` (Fig. 16) | Tabs (`role="tablist"`): Activas / Pendientes de revalidación; type `<select>`; search `<input type="search">` (submitted on Enter or the "Buscar" button); "+ Nueva unidad"; "Retirar por PR" (dialog: PR number + reason); table: `TypeChip`, Título + summary, `StatusChip`, Versión, Origen, Actualizada, actions (Activas: Ver / Editar / Retirar; Pendientes: Ver / Confirmar / Retirar); "Cargar más" when `nextCursor` | `listMemories(p, {status, type, q, cursor})`; `confirmMemory`; `retireMemory`; `retireByPr` | `RetireDialog` (reason 3–500, required). Retire-by-PR: a confirm step "Se retirarán todas las unidades activas originadas en la PR n", then toast "Se retiraron n unidades" (0 → "No había unidades activas de esa PR"). Confirm → toast "Unidad confirmada; vuelve a estar activa". Each action reloads the first page |
| **Detalle de memoria** `#/memory/:memoryId` | Header chips, metadata (provenance, author, approver, repo slug, origin, revalidateAt, retiredReason), content + `FieldsView`, **Historial de versiones** (`<ol>` newest first, each with op label, author, date and a `<details>` showing that revision's content); Editar / Retirar / Confirmar per status | `getMemory`; `retireMemory`; `confirmMemory` | `revisionsTruncated` → "Se muestran las 100 versiones más recientes" |
| **Formulario** `#/memory/new`, `#/memory/:id/edit` | `MemoryForm`: type `<select>` (locked on edit), title (≤120, counter), summary (≤200), body (≤2000), `FieldsEditor` (type-specific inputs from `FIELD_SPECS`); "Previsualizar" → **PreviewPanel** (outcome banner "Se incorporará" / "Irá a cuarentena ({reasonCode})"; judge card: verdict, criterion, confidence vs threshold, reason, related; pipeline findings as category chips; masked preview content) → "Confirmar" | Edit prefill: `getMemory` (`expectedRevision = version`). `previewMemory(p, {op:'add'|'amend', …, targetMemoryId?, expectedRevision?})`; then `createMemory` / `amendMemory` with `confirm: true` | Any edit after a preview clears it, so Confirmar is only enabled for content that was previewed. Result: `applied` → toast + navigate to the detail; `quarantined` → toast "La unidad fue enviada a cuarentena" + navigate to `#/quarantine`. 409 `target_changed` → message + "Recargar" (re-fetch, keep the user's draft). 400 → form-level message. Client-side length limits mirror the server budgets but are advisory; the server validates |
| **Administración** `#/admin` (Fig. 15) | Cards: **Datos del proyecto** (Nombre, Identificador, created), **Repositorios** (mono `remoteUrl`, "Rama de promoción: {defaultBranch}"), **Miembros y roles** (table: name + email, role label, "Deshabilitado" chip), **Credenciales de servicio** (principal, role, status chip Activa / Vencida / Revocada, expires). No edit controls; note "Vista de solo lectura. Las altas y bajas se gestionan por ticket." | `getAdminSummary(p)` | `/me` is already loaded by App for the user and role |

Field specs (`lib/labels.ts`, matching `src/mcp/fieldsPolicy.ts` keys; `list` = one item per line ↔ `string[]`):

| Type (label) | Fields |
|---|---|
| decision (Decisión) | alternatives (Alternativas descartadas, list), drivers (Factores de la decisión, list) |
| constraint (Restricción) | rule (Regla), scope (Alcance), consequence (Consecuencia) |
| gotcha (Error resuelto) | symptom (Síntoma), root_cause (Causa raíz), fix (Solución) |
| pattern (Patrón) | statement (Enunciado), applies_to (Se aplica a, list) |
| integration_note (Nota de integración) | system (Sistema), quirk (Particularidad), workaround (Solución alternativa) |
| domain_rule (Regla de dominio) | rule (Regla), enforced_in (Dónde se aplica) |
| outcome (Resultado) | about (Sobre), result (Resultado), metrics (Métricas) |

`FieldsEditor` omits empty inputs from `fields`, because the server rejects unknown keys only. `FieldsView` renders unknown keys with the raw key as the label, so data from older shapes is still visible as text.

## Visual tokens (`styles.css`, from the mockups)

```css
:root {
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;  --mono: ui-monospace, "SFMono-Regular", Consolas, monospace;
  --bg: #f4f4f4; --surface: #ffffff; --border: #e4e4e4; --text: #111111; --text-muted: #5f5f5f;
  --sidebar-bg: #000000; --sidebar-text: #ffffff; --sidebar-muted: #a3a3a3; --sidebar-active: #1c1c1c;
  --green: #2ec866; --green-text: #0f6b33; --danger: #b0123d; --badge-red: #f2385a;
  --yellow-bg: #fff3cc; --yellow-text: #7a5300; --bar: #f9c22e; --bar-track: #ececec;
  --neutral-bg: #ececec; --neutral-text: #3d3d3d; --pink-bg: #fde7ee; --pink-text: #b0123d;
  --radius: 12px; --radius-pill: 999px; --focus: 0 0 0 3px #1a73e8;
}
.chip--decision{background:#e3f3fa;color:#0b5f80} .chip--constraint{background:#f5e6f6;color:#7d2380}
.chip--gotcha{background:#fde7ee;color:#b0123d}  .chip--pattern{background:#fff3cc;color:#7a5300}
.chip--integration_note{background:#e5f5ea;color:#1b6e35} .chip--domain_rule{background:#ebeafd;color:#3d36b8}
.chip--outcome{background:#ececec;color:#3d3d3d}
.chip--active{background:#e5f5ea;color:#1b6e35} .chip--pending_revalidation{background:#fff3cc;color:#7a5300}
.chip--superseded,.chip--deprecated{background:#ececec;color:#3d3d3d}
```

- The brand is "crombie" + a green "." + " memoria", with the subtitle "Memoria compartida y gobernada" and the footer "Interfaz de gobierno · v1.0".
- The active nav item has a left 4 px `--green` border on `--sidebar-active`. The review badge is green and the quarantine badge is `--badge-red`.
- Buttons:
  - Primary "Aprobar e incorporar" / "Restaurar": `--green` background, black text.
  - Danger "Rechazar…": white with a `--danger` border and text.
  - Secondary: white with a black border.
  - Filter pills: the selected pill is black with white text.
- `ConfidenceBar`: 8 px track `--bar-track`, fill `--bar`, value text "0,62" beside it, and in the detail view "umbral 0,80". The bar is `aria-hidden`, and the number is visible text.
- Layout targets 1440×900 (out of scope: mobile). The grid is a 280 px sidebar plus a fluid main area. The detail screens use two columns, `minmax(0, 1.35fr) minmax(0, 1fr)`.
- All text/background pairs above are ≥ 4.5:1. Focus uses `:focus-visible { box-shadow: var(--focus) }` and is never removed.

## Accessibility

- Landmarks: `<aside>` > `<nav aria-label="Principal">`, `<header>`, `<main>`. Nav links use `aria-current="page"`. Badges carry `aria-label="4 pendientes"`.
- Tables use `<caption class="visually-hidden">` and `<th scope="col">`. Action buttons include the item title in their accessible name, e.g. `aria-label="Revisar: {title}"`.
- Every input has a `<label>`. Field errors are linked with `aria-describedby` and announced with `aria-invalid`. Filter pills are `<button aria-pressed>`, and the memory tabs use `role="tab"` / `aria-selected`.
- Dialogs use native `<dialog>.showModal()`, which provides a focus trap and Esc. Focus returns to the opener on close, and the first field gets focus on open.
- Toasts go to a polite live region, and errors use `role="alert"`. Busy buttons show "Procesando…" text, not just a spinner.

## Data Flow

```
main.tsx ── createStorage(localStorage) ── createApiClient({fetchFn, getDevUser})
   │
   └─ <ToastProvider><App api storage/></ToastProvider>
        App: useHashRoute() ─ route
             getMe() ──▶ projects[] ─ pick storage.projectId ∈ projects (else first) ─ role
             role = project_admin ? listReviewQueue(limit 1).counters.pending + listQuarantine(limit 200) ─▶ badges
             <Sidebar badges route/> <TopBar me project role devUser onChange/>
             <Screen key={devUser+projectId} api projectId role refreshBadges/>
                 useAsync(() => api.listX(projectId, filters)) ─▶ Loading | Error | Empty | Table
                 action ─▶ api.write(...) ─▶ toast + reload/navigate + refreshBadges()

fetch /api/v1/... (+ X-Dev-User) ──▶ Vite proxy :5173 → :3000 (dev)  |  same-origin Express (compose)
        ▼
 Express /api ─▶ apiLimiter ─▶ apiAuth (DevAuthenticator: header → seeded user) ─▶ projectAdmin|projectMember ─▶ routes (C2–C5, admin-summary)
        ▼                                                                                     │
  JSON 2xx ──▶ client ──▶ typed DTO          4xx/5xx {error[,code]} ──▶ ApiError(kind) ──▶ errorMessage() (Spanish)

docker compose up --build:
  deps (pnpm install --frozen-lockfile) ─┬─▶ builder (tsc server, prune --prod) ─┐
                                         └─▶ web-builder (typecheck:web, build:web)┴─▶ runtime: /app/dist + /app/web
  app env WEB_STATIC_DIR=/app/web ─▶ mountWebStatic (C2): index.html + CSP, /assets/*, SPA fallback
```

## Contracts

| Name | Kind | Declared in | Consumed by |
|------|------|-------------|-------------|
| `GET /api/v1/projects/:projectId/admin-summary` | endpoint | `src/http/api/adminRoutes.ts` | `packages/web/src/api/client.ts`, `scripts/smoke.ts` |
| `AdminSummaryDto` | type | `src/http/api/types.ts` (mirrored in `packages/web/src/api/types.ts`) | `src/db/adminSummaryRepository.ts`, `src/http/api/adminRoutes.ts`, `packages/web/src/screens/AdminScreen.tsx` |
| `AdminSummaryRepository`, `PgAdminSummaryRepository` | interface / class | `src/db/adminSummaryRepository.ts` | `src/http/api/adminRoutes.ts`, `src/http/api/router.ts`, `src/index.ts`, `tests/http/api/helpers.ts` |
| `ApiRouterDeps.adminSummaryRepository` | type | `src/http/api/types.ts` | `src/http/api/router.ts`, `src/index.ts`, `tests/http/api/helpers.ts` |
| `ApiAction += 'admin_summary.read'` | type | `src/mcp/context.ts` | `src/http/api/adminRoutes.ts`, `src/auth/auditLogger.ts` (maps to `read`, no code change) |
| `makeAdminRoutes` | func | `src/http/api/adminRoutes.ts` | `src/http/api/router.ts` |
| Web DTO mirror (`MeDto`, `ReviewQueue*`, `ReviewItemDetailDto`, `Quarantine*`, `Memory*`, `PreviewResponseDto`, `DirectWriteResponseDto`, `AdminSummaryDto`, `ConflictCode`, unions) | type | `packages/web/src/api/types.ts` | `packages/web/src/api/client.ts`, `packages/web/src/lib/*.ts`, `packages/web/src/components/*.tsx`, `packages/web/src/screens/*.tsx` |
| `createApiClient`, `ApiClient`, `ApiError`, `ApiErrorKind`, `errorMessage` | func / interface / class | `packages/web/src/api/client.ts` | `packages/web/src/main.tsx`, `packages/web/src/App.tsx`, `packages/web/src/screens/*.tsx` |
| `parseHash`, `buildHash`, `useHashRoute`, `Route` | func / type | `packages/web/src/lib/hashRoute.ts` | `packages/web/src/App.tsx`, `packages/web/src/components/Sidebar.tsx`, `packages/web/src/screens/*.tsx` |
| `createStorage`, `DEV_USERS` | func / const | `packages/web/src/lib/storage.ts` | `packages/web/src/main.tsx`, `packages/web/src/App.tsx`, `packages/web/src/components/TopBar.tsx` |
| `useAsync` | func | `packages/web/src/lib/useAsync.ts` | `packages/web/src/App.tsx`, `packages/web/src/screens/*.tsx` |
| `typeLabel`, `statusLabel`, `roleLabel`, `criterionShort`, `criterionLong`, `reasonCodeLabel`, `quarantineCriterionLabel`, `opLabel`, `FIELD_SPECS`, `MESSAGES` | func / const | `packages/web/src/lib/labels.ts` | `packages/web/src/api/client.ts` (`MESSAGES`), `packages/web/src/components/*.tsx`, `packages/web/src/screens/*.tsx` |
| `formatConfidence`, `formatDateTime`, `formatRelativeDays`, `formatExpiry`, `formatOrigin`, `initials` | func | `packages/web/src/lib/format.ts` | `packages/web/src/components/*.tsx`, `packages/web/src/screens/*.tsx` |
| `ToastProvider`, `useToast` | component / hook | `packages/web/src/components/Toast.tsx` | `packages/web/src/main.tsx`, `packages/web/src/screens/*.tsx` |
| `ScreenProps` (`{ api; projectId; role; refreshBadges; navigate }`) | type | `packages/web/src/screens/types.ts` | `packages/web/src/App.tsx`, `packages/web/src/screens/*.tsx` |

Formatter signatures (pure; `now` is injectable for tests):

```ts
formatConfidence(v: number | null): string                 // 0.62 → "0,62"; null → "—"
formatDateTime(iso: string, now?: Date): string             // "Hoy, 10:42" | "Ayer, 18:03" | "12/03/2026, 09:15" (local time)
formatRelativeDays(iso: string, now?: Date): string         // "Hoy" | "Hace 1 día" | "Hace n días"
formatExpiry(days: number | null): string                   // 58 → "58 días"; 1 → "1 día"; 0 → "Hoy"; null → "—"
formatOrigin(branch: string | null, pr: number | null): string // "feature/x · PR 184" | "feature/x" | "PR 184" | "—"
initials(name: string | null, email: string): string        // "Tech Lead (demo)" → "TL"; null → first letter of email, uppercase
```

## File Changes

Batches:
- **A** runs first and is server contracts only.
- **B** (server implementation) needs A.
- **C** (web scaffold + root tooling) runs in parallel with A and B. It requires the human dependency install to be committed first.
- **D** (web foundation) needs C.
- **E** (shared components) needs D.
- **F** (screens) needs E, and every file in F is independent.
- **G** (App composition) needs F and B.
- **H** (Docker, compose, docs) needs C and can run in parallel with D–G.

No file appears in two batches.

| File | Action | Description |
|------|--------|-------------|
| **A — Server contracts** | | |
| `src/mcp/context.ts` | Modify | `ApiAction` += `'admin_summary.read'` |
| `src/http/api/types.ts` | Modify | `AdminSummaryDto`; `ApiRouterDeps.adminSummaryRepository` |
| **B — Admin summary implementation** | | |
| `src/db/adminSummaryRepository.ts` | Create | `AdminSummaryRepository` + `PgAdminSummaryRepository` (4 queries above; explicit columns; never `token_hash`) |
| `src/http/api/adminRoutes.ts` | Create | `makeAdminRoutes`: strict empty query, `getAdminSummary` (null → NOT_FOUND), `recordApi('admin_summary.read', {resultCount})` after success |
| `src/http/api/router.ts` | Modify | Mount `makeAdminRoutes` on the nested project router behind `projectAdmin` |
| `src/index.ts` | Modify | `new PgAdminSummaryRepository(pool)` into `ApiRouterDeps` |
| `tests/http/api/helpers.ts` | Modify | `FakeAdminSummaryRepository` default in `makeApiTestApp` |
| `tests/http/api/adminSummary.test.ts` | Create | Route tests (see Test Strategy) |
| `tests/db/adminSummary.integration.test.ts` | Create | DB-gated SQL tests |
| `scripts/smoke.ts` | Modify | `GET /api/v1/projects/<seed>/admin-summary` as `tl@demo.local` → 200, no `token` key; as `viewer@demo.local` → 404 |
| **C — Web scaffold and root tooling** | | |
| `packages/web/package.json` | Modify | `"type": "module"`, scripts `dev: vite`, `build: vite build` (deps already added by the human) |
| `packages/web/index.html` | Create | `lang="es"`, meta charset/viewport, `<title>crombie. memoria</title>`, favicon link, `<div id="root">`, module script `/src/main.tsx`; no inline script/style |
| `packages/web/public/favicon.svg` | Create | Static icon (prevents a 404 console error) |
| `packages/web/vite.config.ts` | Create | plugin-react, port 5173, `/api` proxy → `http://localhost:3000`, `outDir: dist`, `modulePreload.polyfill: false` |
| `packages/web/tsconfig.json` | Create | Browser/Bundler/JSX strict config (see decision) |
| `packages/web/src/main.tsx` | Create | `createRoot`, `createStorage(window.localStorage)`, `createApiClient`, `<ToastProvider><App/></ToastProvider>`, imports `styles.css` |
| `packages/web/src/styles.css` | Create | Tokens, layout, chips, table, buttons, bar, dialog, toast, focus styles, `.visually-hidden` |
| `package.json` | Modify | Scripts `dev:web`, `build:web`, `typecheck:web`; `lint` covers `packages/web/src packages/web/vite.config.ts` |
| `eslint.config.mjs` | Modify | Ignore `packages/web/dist/**`; `packages/web/**` block with `no-restricted-syntax` (HTML sinks), `no-eval`, `no-implied-eval`, `no-new-func` |
| `vitest.config.ts` | Modify | `include` += `'packages/web/src/**/*.test.ts'` |
| `packages/web/README.md` | Modify | Scripts, dev proxy, dev user selector, no-HTML rule |
| **D — Web foundation (pure + client)** | | |
| `packages/web/src/api/types.ts` | Create | DTO mirror + `as const` unions (source-section comments) |
| `packages/web/src/api/client.ts` | Create | `createApiClient`, `ApiError`, `errorMessage` |
| `packages/web/src/api/client.test.ts` | Create | Client tests |
| `packages/web/src/lib/labels.ts` | Create | Spanish label maps, `FIELD_SPECS`, `MESSAGES` |
| `packages/web/src/lib/labels.test.ts` | Create | Exhaustiveness + "Juez" wording |
| `packages/web/src/lib/format.ts` | Create | Formatters |
| `packages/web/src/lib/format.test.ts` | Create | Formatter tests |
| `packages/web/src/lib/hashRoute.ts` | Create | `parseHash`, `buildHash`, `useHashRoute` |
| `packages/web/src/lib/hashRoute.test.ts` | Create | Parse/build round trip |
| `packages/web/src/lib/storage.ts` | Create | `createStorage`, `DEV_USERS` |
| `packages/web/src/lib/storage.test.ts` | Create | Allowlist validation, throwing storage fallback |
| `packages/web/src/lib/useAsync.ts` | Create | Loading/ready/error hook with stale-response guard |
| `packages/web/src/security.test.ts` | Create | Source scan for HTML sinks and lint suppressions |
| **E — Shared components** | | |
| `packages/web/src/screens/types.ts` | Create | `ScreenProps` |
| `packages/web/src/components/Sidebar.tsx` | Create | Brand, nav with badges, `aria-current`, footer |
| `packages/web/src/components/TopBar.tsx` | Create | Project `<select>`, dev user `<select>`, role label, avatar initials |
| `packages/web/src/components/Chip.tsx` | Create | `TypeChip`, `StatusChip`, `ReasonChip`, `Chip` (variant class) |
| `packages/web/src/components/ConfidenceBar.tsx` | Create | Bar + value (+ optional threshold) |
| `packages/web/src/components/FilterBar.tsx` | Create | Pill buttons with `aria-pressed` |
| `packages/web/src/components/StateViews.tsx` | Create | `Loading`, `Empty`, `ErrorMessage`, `NoAccess` |
| `packages/web/src/components/ConfirmDialog.tsx` | Create | Native `<dialog>` confirm (title, text, confirm label, busy) |
| `packages/web/src/components/RetireDialog.tsx` | Create | `<dialog>` with a required reason (3–500); used by the memory list and detail |
| `packages/web/src/components/FieldsView.tsx` | Create | Read-only typed fields as text (review, quarantine and memory details) |
| `packages/web/src/components/FieldsEditor.tsx` | Create | Inputs from `FIELD_SPECS` ↔ `fields` object |
| `packages/web/src/components/Toast.tsx` | Create | `ToastProvider`, `useToast`, live region |
| **F — Screens** | | |
| `packages/web/src/screens/ReviewQueueScreen.tsx` | Create | Fig. 12 |
| `packages/web/src/screens/ReviewDetailScreen.tsx` | Create | Fig. 13 |
| `packages/web/src/screens/QuarantineScreen.tsx` | Create | Fig. 14 list + restore |
| `packages/web/src/screens/QuarantineDetailScreen.tsx` | Create | Quarantine detail + restore |
| `packages/web/src/screens/MemoryScreen.tsx` | Create | Fig. 16 tabs, filters, search, pagination, confirm/retire, retire-by-PR |
| `packages/web/src/screens/MemoryDetailScreen.tsx` | Create | Detail + version history |
| `packages/web/src/screens/MemoryFormScreen.tsx` | Create | Create/edit with preview-then-confirm (`PreviewPanel` local to this file) |
| `packages/web/src/screens/AdminScreen.tsx` | Create | Fig. 15 read-only |
| **G — Composition** | | |
| `packages/web/src/App.tsx` | Create | `/me`, project and role, badges, route → screen switch, `key` remount, focus management |
| **H — Docker, compose, docs** | | |
| `Dockerfile` | Modify | `deps` → `builder` + `web-builder` → `runtime` (+ `COPY … ./web`) |
| `.dockerignore` | Modify | Un-ignore web sources/config/public; re-ignore `packages/web/src/**/*.test.ts` |
| `docker-compose.yml` | Modify | `app.environment.WEB_STATIC_DIR: /app/web` (dev only) |
| `README.md` | Modify | Web section: `pnpm dev:web`, `pnpm build:web`, compose URL `http://localhost:3000/` |
| `DEVELOPMENT.md` | Modify | Web dev workflow (server with `AUTH_DEV_BYPASS` + Vite proxy), demo users, verification line, CSP notes |

## New Modules

| Path | Type | Shape |
|------|------|-------|
| `packages/web` | frontend | dir |

## Test Strategy

The runner is root vitest (`environment: node`).
- Web tests: `packages/web/src/**/*.test.ts`.
- Server tests: `tests/**`.
- DB-gated suites skip without `DATABASE_URL`, using the existing pattern.
- There are no component tests (no jsdom). The UI is verified by the manual compose acceptance run below.

| Component | Test type | Key scenarios | Notes |
|-----------|-----------|---------------|-------|
| `api/client.ts` requests | unit | Each method builds the exact method + URL (`/api/v1/projects/<id>/review-queue?filter=uncertain&type=decision`); path ids are `encodeURIComponent`-ed (`a/b` → `a%2Fb`); undefined/empty query values omitted; POST bodies exact (`approve` without `targetRevision` omits the key; `confirm`/`restore` send `{}`; create/amend include `confirm: true`); `X-Dev-User` present when `getDevUser()` returns an email and absent when null; no `Authorization` header ever; `cache: 'no-store'` | Fake `fetchFn` records calls and returns `new Response(JSON.stringify(fixture), {status})`; fixtures copied from the C2–C5 DTO blocks |
| `api/client.ts` errors | unit | 401/404/400/429/500/503 → `kind`; 409 `{error:'Conflict',code:'target_changed'}` → `conflict` + code; 409 with unknown code → `conflict`, `conflictCode` undefined; `fetchFn` rejects → `network`, status null; 200 with non-JSON → `server`; `errorMessage` gives the Spanish text for every kind and code and never includes the server `error` string; non-`ApiError` → generic message | |
| `lib/labels.ts` | unit | Every `MemoryType`, `MemoryStatus`, `ProjectRole`, `DecisionCriterion`, `QuarantineReasonCode`, `QuarantineCriterion` and op has a non-empty label (iterate the `as const` arrays); `FIELD_SPECS` keys equal the server allow-list per type (literal copy asserted); no label or message contains "evaluador"; judge strings contain "Juez" | |
| `lib/format.ts` | unit | `formatConfidence` 0.62 → "0,62", 1 → "1,00", null → "—"; `formatDateTime` today/yesterday/older with a fixed `now`; `formatRelativeDays` 0/1/n; `formatExpiry` 0/1/58/null; `formatOrigin` all four combinations; `initials` display name / null name | Fixed `now` dates; avoid TZ flakiness by building inputs with the local `Date` constructor |
| `lib/hashRoute.ts` | unit | `parseHash` for every route; `buildHash(parseHash(h)) === h` round trip; unknown, empty or `#/review/not-a-uuid` → list route; trailing slash tolerated | |
| `lib/storage.ts` | unit | Default `tl@demo.local`; stored allowlisted value returned; tampered value (`evil@x`) ignored; `setDevUser` rejects unknown emails; storage that throws → defaults + `console.warn` (spied) | Map-backed fake |
| XSS guard | unit (`security.test.ts`) + lint | No HTML sinks or rule suppressions in `packages/web/src`; ESLint fails on a fixture snippet with `dangerouslySetInnerHTML` (via `ESLint` API `lintText` with `filePath` under `packages/web/src`) | `eslint` is already a root dev dependency |
| Admin summary route | unit (`adminSummary.test.ts`) | tl admin → 200 with exact DTO keys; contributor, viewer, non-member, malformed id, random id → byte-identical 404 `{"error":"Not found"}` and no audit row; repository null → 404; unknown query key from an admin → 400, from a non-admin → 404; audit `admin_summary.read` with `{resultCount}` only after success; serialized body contains no `token`/`token_hash` key and not the fake hash value | `makeApiTestApp` + `InMemoryAuthRepository` |
| Admin summary SQL | integration (DB-gated) | Seed project → project, repos with `defaultBranch`, the three demo members + roles, `disabled` true for a disabled user; credentials status active/expired/revoked; other project's repos, members and credentials excluded; archived project → null; returned row objects have no `token_hash` property | |
| Lint/typecheck coverage | CI line | `pnpm build && pnpm typecheck:web && pnpm build:web && pnpm test -- --run && pnpm lint` all green | |
| Built output CSP | manual + compose | `packages/web/dist/index.html` contains only an external module script and stylesheet link (no inline `<script>`/`<style>`/`style=`); with compose, the browser console shows **no CSP violations** on all screens | Inspect once per release |
| Acceptance (proposal success criteria) | e2e manual (compose, 1440×900) | `docker compose up --build` → `http://localhost:3000/`. As `tl@demo.local`: queue counters, filters and detail; approve (badge decrements), reject without a reason (inline error), reject with a reason → appears in Cuarentena; a stale target shows the banner, and approving with a changed target shows the 409 message; quarantine filters, Ver, Restaurar toast; memory tabs, type filter, search, load more, create → preview shows the Juez verdict → confirm → detail with version 1; edit → version 2 in history; retire with reason; confirm a pending item; retire by PR toast; Administración shows project, repos, members and credentials without secrets. As `viewer@demo.local`: NoAccess on admin screens, quarantine shows only own items, no Restaurar. Console: no errors. Reload on a deep hash route works | `pnpm smoke` covers the API side |
