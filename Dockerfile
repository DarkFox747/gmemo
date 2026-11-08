# ---- deps: one frozen install shared by the server and web builds ----
FROM node:22-alpine AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/web/package.json ./packages/web/package.json
RUN pnpm install --frozen-lockfile

# ---- builder: server ----
FROM deps AS builder
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build
# Drop devDependencies (tsx, tsc, vitest, ...) — prod-only node_modules in the runtime image.
RUN pnpm prune --prod

# ---- web-builder: governance web (C7), built in parallel by BuildKit ----
FROM deps AS web-builder
COPY packages/web ./packages/web
RUN pnpm typecheck:web && pnpm build:web

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app

# prod-safe default; docker-compose overrides to development for local use.
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# package.json is required for ESM resolution (type: "module").
COPY --from=builder /app/package.json ./package.json
# migrations/ is read at runtime by dist/db/migrate.js and dist/db/seed.js.
# Copied from the build context (not from builder) because the builder stage
# does not place migrations/ under /app; the context copy is safe because
# .dockerignore does not exclude migrations/.
COPY migrations ./migrations
# Web build (C7). Served only when WEB_STATIC_DIR=/app/web, which config rejects
# under NODE_ENV=production, so it is inert in the production image.
COPY --from=web-builder /app/packages/web/dist ./web

# Fetch the Amazon RDS global CA bundle so NODE_EXTRA_CA_CERTS can trust RDS
# under NODE_ENV=production (src/db/pool.ts: rejectUnauthorized: true).
# Must run as root (before USER node) to write to /etc/ssl/certs/.
RUN wget -qO /etc/ssl/certs/rds-global-bundle.pem \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

# Integrity guard: verify the bundle is non-empty and contains a valid PEM header.
# A zero-byte or truncated file would silently break RDS TLS trust at runtime.
RUN test -s /etc/ssl/certs/rds-global-bundle.pem && \
    grep -q "BEGIN CERTIFICATE" /etc/ssl/certs/rds-global-bundle.pem
# To pin a specific hash, generate it out-of-band with:
#   sha256sum /etc/ssl/certs/rds-global-bundle.pem
# then uncomment and fill the line below. Re-pin after any CA rotation by AWS.
# RUN echo "<sha256-hash>  /etc/ssl/certs/rds-global-bundle.pem" | sha256sum -c

# Run as the non-root node user (uid 1000) that ships with node:alpine.
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
