# Tasks: governance-web (C7)

> spec ↔ design reconciled (governance-web spec ↔ design batches A–H). Requires the human-added web dependencies (lockfile committed) and C2–C5 landed. TDD for client and pure functions. Exact files: design.md § File Changes, batch named in each task.

- [x] 1.1 (A) Package scaffold, tooling (root scripts, vitest include, eslint coverage + XSS rule, tsconfig), API types + client + pure libs with tests (design batch A) [declares:WebClient] [declares:module-web]
- [x] 1.2 (B) Server: admin-summary endpoint, repository, route, audit, tests (design batch B)
- [x] 2.1 (C) Shell: App, layout, sidebar, dev user selector, project selector, toasts, hash router, styles (design batch C) [consumes:WebClient] [declares:module-web]
- [x] 2.2 (D, E) Review queue + review detail screens (design batches D, E) [consumes:WebClient] [declares:module-web]
- [x] 2.3 (F) Quarantine screen (design batch F) [consumes:WebClient] [declares:module-web]
- [x] 2.4 (G) Project memory + administration screens (design batch G) [consumes:WebClient] [declares:module-web]
- [x] 3.1 (H) Docker multi-stage web build, `.dockerignore`, compose `WEB_STATIC_DIR`, docs (design batch H)
- [x] 4.1 Gate: full check (`pnpm build && pnpm typecheck:web && pnpm build:web && pnpm test -- --run && pnpm lint`), DB gate, compose from scratch serving `/`, five screens walked at 1440×900 with seed data, no console errors (Playwright if available)
- [~] 4.2 (deferred — writing the area skill under `.claude/` was denied as self-modification; `packages/web/CLAUDE.md` written but gitignored; prepared skill content left for the owner) Generate area context for packages/web (frontend, shape dir): read .claude/skills/_shared/area-context-convention.md and .claude/skills/_shared/area-templates/frontend.md, run node .claude/area-lint.js --check-write='packages/web/CLAUDE.md,packages/web/.claude/skills/web-area/SKILL.md' before writing, create `packages/web/CLAUDE.md`, `packages/web/.claude/skills/web-area/SKILL.md`, stamp sources via node .claude/area-lint.js --hash='packages/web/src/App.tsx,packages/web/src/api/client.ts', add the area_context entry to `openspec/project-map.yaml`, and finish when node .claude/area-lint.js reports the area `ok` [consumes:module-web]
