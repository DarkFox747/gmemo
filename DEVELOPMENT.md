# Desarrollo — LPMS Cloud

Monorepo del servicio de memoria compartida. El diseño vive en `docs/` (empezar por `docs/README` /
`docs/09-decisiones-abiertas.md`). El esquema de referencia validado está en
`docs/artefactos/lpms_schema_v2.sql` y el contrato del facade en `docs/artefactos/lpms_facade_contract_v1.md`.

## Estructura

```
packages/
  server/   # Facade MCP (Node + TypeScript + Express + Prisma)
  web/      # Web UI de administración/curación (placeholder — más adelante)
  infra/    # IaC (placeholder — Terraform/CDK a definir)
infra/
  docker-compose.yml   # Postgres + pgvector para dev local
docs/                  # diseño + memoria de decisiones
```

## Requisitos
- Node >= 20
- Docker (para el Postgres local)

## Arranque rápido
```bash
cp .env.example .env
npm install
npm run db:up            # levanta Postgres (pgvector) en localhost:5432
npm run dev:server       # server en http://localhost:3000  (GET /health)
```

## Base de datos y migraciones (Prisma)
El stack de datos es **Prisma**, con una salvedad importante del esquema:

- La **columna generada `tsvector`**, los **índices GIN** y **pgvector** NO se modelan en `schema.prisma`
  (Prisma no los soporta nativamente). Se aplican por **migración SQL cruda**: se genera la migración base
  con `prisma migrate dev` y los pedazos avanzados se agregan editando el `.sql` de la migración.
- Config de búsqueda full-text: **`english`** (todo se guarda en inglés). Ajustable.

Flujo: `npm run prisma:migrate -w @lpms/server` · `npm run prisma:generate -w @lpms/server`.

## Estado del scaffold
- [x] Monorepo + toolchain (TS, workspaces)
- [x] Server: Express + `/health` + stubs de las tools MCP
- [x] Postgres local (docker-compose)
- [ ] Traducción completa del esquema v2 a Prisma + migración FTS/pgvector  ← próximo incremento
- [ ] Auth middleware (validación JWT Cognito) + RBAC
- [ ] Implementación de recall / remember / get_context / get_memory
- [ ] Pipeline de promoción + juez
