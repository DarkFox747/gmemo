-- migrations/seed.dev.sql
-- DEV-ONLY sample data. Applied by `pnpm seed:dev` (src/db/seed.ts), which REFUSES
-- when NODE_ENV=production. NOT applied by the migration runner (numbered-only filter).
-- Idempotent: safe to re-run. Fixed UUIDs keep FKs stable across runs.

-- 1) app_user — idp_subject MUST equal DevAuthenticator DEV_PRINCIPAL.subject.
INSERT INTO app_user (id, idp_subject, email, display_name, global_role)
VALUES ('00000000-0000-0000-0000-000000000001',
        'dev-local-user', 'dev@localhost', 'Local Dev User', NULL)
ON CONFLICT (idp_subject) DO NOTHING;

-- 2) project
INSERT INTO project (id, slug, name, created_by)
VALUES ('00000000-0000-0000-0000-000000000010',
        'gmemo', 'gmemo (local dev)',
        '00000000-0000-0000-0000-000000000001')
ON CONFLICT (slug) DO NOTHING;

-- 3) repo — remote_url is the X-Git-Remote value clients must send.
INSERT INTO repo (id, project_id, remote_url, provider, slug, default_branch)
VALUES ('00000000-0000-0000-0000-000000000020',
        '00000000-0000-0000-0000-000000000010',
        'https://github.com/crombie-llc/gmemo-demo.git',
        'github', 'gmemo-demo', 'main')
ON CONFLICT (remote_url) DO NOTHING;

-- 4) project_membership — contributor (read + stage; Decision 3).
INSERT INTO project_membership (id, project_id, user_id, role, granted_by)
VALUES ('00000000-0000-0000-0000-000000000030',
        '00000000-0000-0000-0000-000000000010',
        '00000000-0000-0000-0000-000000000001',
        'contributor', '00000000-0000-0000-0000-000000000001')
ON CONFLICT (project_id, user_id) DO NOTHING;

-- 5) memory rows — one each: constraint, domain_rule, decision, gotcha.
--    content_tsv is GENERATED — do NOT insert it. provenance NOT NULL.
--    Budgets: title<=120, summary<=200, body<=2000. content_hash unique per project.
INSERT INTO memory
  (id, project_id, repo_id, type, title, summary, body,
   provenance, author_identity, content_hash)
VALUES
  ('00000000-0000-0000-0000-000000000040',
   '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000020',
   'constraint',
   'Use pnpm only — npm/yarn/bun are blocked',
   'All installs must use pnpm with a frozen lockfile; other package managers are forbidden.',
   'The repo pins packageManager pnpm@9.15.0 and enforces it via engines + .npmrc engine-strict + a guard hook. Agents run `pnpm install --frozen-lockfile`; humans add deps out-of-band and commit pnpm-lock.yaml.',
   'manual_ui', 'dev-seed', 'seed-constraint-0001'),
  ('00000000-0000-0000-0000-000000000041',
   '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000020',
   'domain_rule',
   'Agents READ and PROPOSE only — writes go to staging',
   'remember() always writes to staging; promotion to main happens only via PR merge or Web UI.',
   'The MCP facade never lets an agent write directly to authoritative memory. All writes buffer in a staging session keyed by (project, repo, branch); a judge gates promotion. Reads require viewer+; writes require contributor/service_agent.',
   'manual_ui', 'dev-seed', 'seed-domainrule-0002'),
  ('00000000-0000-0000-0000-000000000042',
   '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000020',
   'decision',
   'FTS uses the english dictionary (not simple)',
   'content_tsv is generated with to_tsvector(''english'', ...) weighted A/B/C over title/summary/body.',
   'Decided before any data was written (migration 0002). The english dictionary gives stemming for BM25-style recall; weights are title=A, summary=B, body=C. This is the only deviation from schema v2, which used ''simple''.',
   'manual_ui', 'dev-seed', 'seed-decision-0003'),
  ('00000000-0000-0000-0000-000000000043',
   '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000020',
   'gotcha',
   'The dev auth bypass must never reach production',
   'AUTH_DEV_BYPASS=true with NODE_ENV=production fails fast at boot; default is real Cognito.',
   'DevAuthenticator stubs Gate 1 only. The config superRefine refuses to load in the forbidden pairing and index.ts adds a second NODE_ENV guard. Gate 2, RBAC and audit stay real against local Postgres.',
   'manual_ui', 'dev-seed', 'seed-gotcha-0004')
ON CONFLICT (project_id, content_hash) DO NOTHING;

-- 6) machine_credential — enables authorizePromote for the dev OIDC principal.
--    principal_name MUST equal DEV_PROMOTE_PRINCIPAL.repository (see src/auth/devOidcAuthenticator.ts)
--    and must match findRepoByGithubSlug('crombie-llc/gmemo-demo') → repo remote_url canonical slug.
--    token_hash is a non-secret dev placeholder (OIDC bypass active; never used in real auth).
--    revoked_at omitted (NULL = active); expires 10 years out so the harness never needs rotation.
INSERT INTO machine_credential
  (id, project_id, principal_name, token_hash, role, created_by, expires_at)
VALUES ('00000000-0000-0000-0000-000000000050',
        '00000000-0000-0000-0000-000000000010',
        'crombie-llc/gmemo-demo',
        'dev-oidc-not-a-real-secret', 'service_agent',
        '00000000-0000-0000-0000-000000000001', now() + interval '3650 days')
ON CONFLICT DO NOTHING;

-- 7) open staging_session on branch 'main' (the promote target for the dev harness).
--    One open session per (project, repo, branch) enforced by partial unique index ux_session_open.
--    Fixed ULID keeps FK in staging_item stable across re-seeds.
INSERT INTO staging_session (id, project_id, repo_id, branch, status, opened_by, expires_at)
VALUES ('01JDEMOPROMOTESESSION000001',
        '00000000-0000-0000-0000-000000000010',
        '00000000-0000-0000-0000-000000000020',
        'main', 'open', 'dev-local-user', now() + interval '7 days')
ON CONFLICT DO NOTHING;

-- 8) pending add staging_item — secret-free; content_hash does not collide with any seed memory hash.
--    op='add' requires target_memory_id IS NULL (ck_item_optarget CHECK satisfied by omission).
--    Promoting this item via `curl /promote` will: judge (stub) accepts → applyAccepted inserts
--    a new memory row + revision, then the session transitions to 'promoted'.
INSERT INTO staging_item
  (id, session_id, op, type, title, summary, body, content_hash, judge_state, author_identity)
VALUES ('00000000-0000-0000-0000-000000000060',
        '01JDEMOPROMOTESESSION000001',
        'add', 'pattern',
        'Promotion pipeline applies staged adds to memory',
        'A pending add promoted via /promote becomes an authoritative memory row.',
        'Demonstrates the local promotion vertical end to end: judge (stub) accepts, applyAccepted inserts memory + revision, session goes promoted.',
        'stage-add-demo-0001', 'pending', 'dev-local-user')
ON CONFLICT DO NOTHING;

-- 9) Demo users for the web/API (C2). Use them via the X-Dev-User header under AUTH_DEV_BYPASS.
--    C8 adds project "Portal de Clientes" and enriches the data; ids 0005-0009 / 0034-0039 are left free.
INSERT INTO app_user (id, idp_subject, email, display_name, global_role) VALUES
  ('00000000-0000-0000-0000-000000000002', 'demo-tl',     'tl@demo.local',     'Tech Lead (demo)', NULL),
  ('00000000-0000-0000-0000-000000000003', 'demo-dev',    'dev@demo.local',    'Developer (demo)', NULL),
  ('00000000-0000-0000-0000-000000000004', 'demo-viewer', 'viewer@demo.local', 'Viewer (demo)',    NULL)
ON CONFLICT (idp_subject) DO NOTHING;

INSERT INTO project_membership (id, project_id, user_id, role, granted_by) VALUES
  ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000010',
   '00000000-0000-0000-0000-000000000002', 'project_admin', '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000032', '00000000-0000-0000-0000-000000000010',
   '00000000-0000-0000-0000-000000000003', 'contributor',   '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000033', '00000000-0000-0000-0000-000000000010',
   '00000000-0000-0000-0000-000000000004', 'viewer',        '00000000-0000-0000-0000-000000000001')
ON CONFLICT (project_id, user_id) DO NOTHING;
