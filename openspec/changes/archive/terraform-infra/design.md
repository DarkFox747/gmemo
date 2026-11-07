# Design: Terraform Infra — Cheapest-Viable Single-AZ AWS Pilot

> Grounded in the actual runtime: config guards in `src/config/index.ts`, the
> `node:22-alpine` Dockerfile, the standalone `src/db/migrate.ts` runner, and
> migration `0005_embeddings.sql` (`CREATE EXTENSION vector`). This document is
> the design contract for the `terraform-infra` change. It delivers `fmt`-clean,
> `validate`-clean Terraform + a runbook. **`terraform apply` is human/CI,
> out-of-band** — this change does NOT stand up live infrastructure.

---

## ⚠️ DECISIONS THAT NEED YOUR CONFIRMATION (read first)

**Two items remain OPEN** for this revision, both narrow: the **domain input**
(`domain_name` + `route53_zone_name`) and the **`alb_ingress_cidrs` posture**.
**FLAG 7 is now RESOLVED** — TLS/HTTPS is added in this revision (Route53 + ACM),
so tokens travel encrypted end-to-end. FLAG 1 and FLAG 4 remain RESOLVED (REAL
production auth). FLAGS 2/3/5/6 stand as previously accepted.

- **[OPEN #1 — domain input needed]** HTTPS requires a domain. This design expects
  the pilot to answer on a **subdomain of an existing parent zone** — e.g.
  `lpms-pilot.example-fake.dev` under a `example-fake.dev` Route53 hosted zone. You
  must supply **`domain_name`** (the FQDN the pilot answers on) and
  **`route53_zone_name`** (the hosted zone that holds the record). Default path
  **looks up an EXISTING hosted zone** (`data aws_route53_zone`). If you do NOT yet
  have a hosted zone, set **`create_hosted_zone = true`** (default `false`) and the
  design creates the zone — then **NS delegation at the registrar is a runbook
  step** before ACM validation can succeed. **Please supply the domain + zone.**

- **[OPEN #2 — `alb_ingress_cidrs` posture, now that TLS + Cognito are both in
  place]** With real Cognito JWTs **and** end-to-end TLS, an internet-facing
  endpoint is defensible (auth + encryption protect it). **Recommendation: KEEP the
  `alb_ingress_cidrs` allowlist (no default, must be set) as defense-in-depth.** It
  is free, the client set is a small known group of CLI operators, and it blocks
  internet-wide scanning/probing of the auth endpoint before a request ever reaches
  Cognito verification. Opening 443 to **`0.0.0.0/0`** is now **DEFENSIBLE** (TLS +
  Cognito make it safe) and is a **one-line change** if you need clients on dynamic
  IPs — but it is **not** the recommended default. **Please confirm: keep the
  allowlist, or open 443 to the internet?**

- **[FLAG 7 — RESOLVED via HTTPS (Route53 + ACM)]** The ALB now terminates **TLS on
  :443** with a DNS-validated ACM certificate, and the **:80 listener 301-redirects
  to :443** (no plaintext forwarding). The access token therefore travels **over
  TLS end-to-end** client→ALB; the credential exchange with Cognito
  (`initiate-auth`) was already HTTPS. **The cleartext-Bearer residual risk is
  eliminated.** The short **15-min access-token TTL is kept** as good hygiene (bounds
  replay if a token leaks by other means), not as a substitute for transport
  security. See "Decision: DNS + TLS (Route53 + ACM)" and the revised "Decision:
  ALB (HTTPS with :80→:443 redirect)".

- **[FLAG 1 — RESOLVED → Option (a): minimal Cognito, run as production]** The
  pilot now runs **`NODE_ENV=production`**. All four prod guards are satisfied by
  construction: `AUTH_DEV_BYPASS=false`, `PROMOTE_OIDC_DEV_BYPASS=false`,
  `JUDGE_STUB=false`, `EMBEDDER_STUB=false` (real Bedrock). Gate 1 = real Cognito
  (new `modules/cognito`). Consequences (full list in "Decision: Prod-auth
  reconciliation"): **`/promote` is fail-closed this pilot** (real GitHub-OIDC
  verify deferred; `GITHUB_OIDC_AUDIENCE` is still supplied as a *placeholder* so
  boot succeeds), and authenticated Cognito users **additionally need RDS Gate-2
  rows** (manual SQL, no seed) before read/stage will work.

- **[FLAG 4 — RESOLVED: app-side RDS TLS now enforced]** Under `NODE_ENV=production`
  `src/db/pool.ts` sets `{ rejectUnauthorized: true }`. Resolved **without a code
  change** by baking the RDS global CA bundle into the image and pointing
  `NODE_EXTRA_CA_CERTS` at it, plus `rds.force_ssl=1` server-side. See "Decision:
  RDS TLS trust under production".

- **[FLAG 2 — accepted]** "1 public + 1 private subnet" is impossible: an ALB and
  an RDS DB subnet group each require **≥2 AZs**. We provision **2 public + 2
  private subnets across 2 AZs** (subnets are free) but keep a **single-AZ COST
  posture**: one Fargate task, single-AZ RDS (no standby), no NAT.

- **[FLAG 3 — accepted]** **Fargate task in a public subnet** with a public IP and
  an SG that allows inbound only from the ALB SG. Saves ~**$32/mo** vs. NAT and
  ~**$36/mo** vs. 5 interface endpoints. RDS stays fully private.

- **[FLAG 5 — accepted]** DB password (`random_password`) assembled into a
  `DATABASE_URL` in Secrets Manager lands in the pilot state file. Mitigated by:
  encrypted + public-access-blocked S3 backend, DynamoDB lock, `sensitive = true`
  outputs, and **never committing `.tfstate`**. (Cognito user passwords are **NOT**
  in state — see the Cognito decision.)

- **[FLAG 6 — accepted]** If the judge model id is a cross-region **inference
  profile** (e.g. `us.anthropic.claude-3-5-haiku-…`), the task role needs
  `bedrock:InvokeModel`/`bedrock:Converse` on BOTH the inference-profile ARN AND
  the underlying foundation-model ARNs in each region the profile routes to. The
  allowed ARNs are a variable (`bedrock_model_arns`) — least-privilege and explicit.

---

## Technical Approach

Two Terraform roots, applied in order, exactly matching the proposal's two layers:

1. **`terraform/bootstrap/`** (local state): creates the versioned, encrypted,
   public-access-blocked S3 state bucket + the DynamoDB lock table. Applied once.
2. **`terraform/envs/pilot/`** (S3 backend, adopted after step 1): wires five
   thin modules — `network`, `data`, `cognito`, `dns-tls`, `service` — into the
   running pilot.

The pilot runs the **same `node:22-alpine` image** the app already ships
(`Dockerfile`, `CMD ["node","dist/index.js"]`, `EXPOSE 3000`). Config is injected
via the ECS task definition: non-secret values as `environment`, the DB
connection string as a Secrets Manager `secrets` entry. Migrations (including
`CREATE EXTENSION vector`) run as a **one-off ECS task** that reuses the image
with a `command` override of `["node","dist/db/migrate.js"]` — never at container
boot (`src/index.ts` does not migrate; it only `loadConfig → createPool → listen`).

The design is deliberately minimal: no NAT, no VPC endpoints, no Multi-AZ, no
autoscaling, no WAF/API-GW, **no CloudFront, one cert, one domain, no wildcard**. A
**minimal real Cognito user pool IS included** (Gate 1) per the resolved FLAG 1, and
**a minimal DNS+TLS layer (Route53 + ACM) IS now included** (resolving FLAG 7) — the
pilot runs `NODE_ENV=production`, so Cognito, real Bedrock, app-side RDS TLS, and
ALB TLS termination are all load-bearing. Modules are concrete, not generalized —
one shape each, no speculative variables.

**Rough monthly cost** (us-east-1, excludes Bedrock token usage): ALB ~$17 +
Fargate (0.25 vCPU/512 MB) ~$9 + RDS `db.t4g.micro` 20 GB gp3 ~$14 + 1 public
IPv4 ~$3.6 + Secrets Manager ~$0.40 + **Route53 hosted zone ~$0.50** (only if
`create_hosted_zone = true`; $0 when reusing an existing zone) ≈ **~$46/mo**.
**ACM public certificates are free.** NAT would add ~$32; interface endpoints ~$36.
**Cognito is free under 50k MAUs.** The public-subnet + public-ACM pattern is the
cheapest TLS-terminated reachable option (no CloudFront/WAF).

---

## Architecture Decisions

### Decision: Prod-auth reconciliation (RESOLVED → real production)

**Choice**: Run the pilot task with **`NODE_ENV=production`** and all four
bypass/stub flags OFF — `AUTH_DEV_BYPASS=false`, `PROMOTE_OIDC_DEV_BYPASS=false`,
`JUDGE_STUB=false`, `EMBEDDER_STUB=false` (real Bedrock). Gate 1 is served by a
minimal **real Cognito** user pool (new `modules/cognito`). This is REAL
production auth for the pilot.

**Why the app forces the issue** — from `src/config/index.ts` there are **four
hard prod guards** (each fails boot when `NODE_ENV=production`):

| Guard | In `NODE_ENV=production` forbids… | …therefore REQUIRES |
|-------|-----------------------------------|---------------------|
| A | `AUTH_DEV_BYPASS=true` | `COGNITO_USER_POOL_ID` + `COGNITO_CLIENT_ID_ALLOWLIST` + `COGNITO_REQUIRED_SCOPE` |
| B | `JUDGE_STUB=true` | `BEDROCK_MODEL_ID` |
| C | `PROMOTE_OIDC_DEV_BYPASS=true` | `GITHUB_OIDC_AUDIENCE` |
| D | `EMBEDDER_STUB=true` | `BEDROCK_EMBEDDING_MODEL_ID` + `AWS_REGION` |

Running production therefore requires ALL of the right-hand vars. Cognito (A) is
delivered by the new module; Bedrock (B, D) is already in the design; OIDC (C) is
handled as a placeholder (below).

**What else breaks / must be handled under `NODE_ENV=production`** (each resolved
in this design):

1. **RDS TLS becomes mandatory app-side.** `src/index.ts:53` and
   `src/db/migrate.ts:29` both call `createPool(url, NODE_ENV==='production')` →
   `{ rejectUnauthorized: true }`. Resolved via `NODE_EXTRA_CA_CERTS` + a baked RDS
   CA bundle + `rds.force_ssl=1` — see "Decision: RDS TLS trust under production".
2. **`GITHUB_OIDC_AUDIENCE` is required at boot** even though `/promote` is not
   exercised this pilot (guard C). We supply a **placeholder** so boot succeeds;
   `src/index.ts:144` constructs `GithubOidcAuthenticator(GITHUB_OIDC_AUDIENCE)`
   but it is never invoked (no CI caller; real GitHub-OIDC verification and
   `machine_credential` rows are deferred to hardening). **`/promote` is therefore
   effectively closed / fail-closed** — the pilot exercises **read + stage**;
   human promote is OUT until OIDC lands. Acceptable per the user's intent.
3. **`Dockerfile ENV NODE_ENV=production` is now CORRECT.** The earlier plan to
   override `NODE_ENV=development` in the task def is **REMOVED**; the task def
   keeps production (image default; may be set explicitly for clarity).
4. **Gate 2 still applies — Cognito only passes Gate 1.** `RdsAuthorizer.authorize`
   (`src/auth/authorizer.ts:64`) requires an `app_user` row whose `idp_subject`
   equals the Cognito `sub`, PLUS a `project_membership` row; and tenant
   resolution (`src/auth/tenantResolver.ts:37`) requires a registered `repos` row
   keyed by the `X-Git-Remote` header. The pilot does **NOT** run `seed`, so these
   rows must be provisioned **by hand (SQL)** AFTER users exist and their `sub`
   values are known (runbook). Until then an authenticated user is still denied
   (opaque `PERMISSION_DENIED`) — correct fail-closed behavior, but read/stage
   only works once Gate-2 rows are inserted.

**Alternatives considered**:
- **(b) `NODE_ENV=development` + `AUTH_DEV_BYPASS`** (the previous default) —
  rejected: the user chose REAL production auth; the bypass path exposes an
  unauthenticated MCP endpoint and would keep Cognito out of the loop.
- **(c) Deploy infra, service at `desired_count = 0`** — rejected as default (no
  reachable service, defeating the goal of "the SAME image running on AWS,
  reachable"). Retained as a general operational lever (`desired_count` is a
  variable) — e.g. to pause the pilot — but no longer tied to FLAG 7, which is
  resolved by TLS.

### Decision: Cognito user pool (minimal, admin-provisioned, `USER_PASSWORD_AUTH`)

**Choice**: A new **`modules/cognito`** provisions exactly one user pool + one app
client, sized to the app's real Gate-1 contract — `src/index.ts:81` builds
`CognitoJwtVerifier.create({ userPoolId, tokenUse:'access', clientId:<allowlist>,
scope:<required scope> })`:

- **User pool**: `admin_create_user_config { allow_admin_create_user_only = true }`
  (**no self sign-up**), `username_attributes = ["email"]` (sign in with email),
  a sane password policy (min 12; upper/lower/number/symbol). **No** hosted UI,
  **no** domain, **no** identity providers, **no** resource server, **no** groups
  (RBAC stays in RDS, Gate 2). **No SES**: user invites are suppressed (below), so
  the default Cognito email path is never used.
- **App client**: `generate_secret = false` (**public client** → simple CLI
  `initiate-auth`, no secret to distribute), `explicit_auth_flows =
  ["ALLOW_USER_PASSWORD_AUTH","ALLOW_REFRESH_TOKEN_AUTH"]`, **short TTLs**
  (`access_token_validity = 15` min, id 15 min, `refresh_token_validity = 1` day,
  via `token_validity_units`). No `allowed_oauth_flows` / callback URLs — not
  needed for `USER_PASSWORD_AUTH`.
- **Authorized users**: `aws_cognito_user` `for_each` over
  `var.authorized_user_emails` (list of `@<COMPANY_DOMAIN>` emails), each with
  `message_action = "SUPPRESS"` and **NO password set in Terraform** — so **no user
  secret ever lands in state**. Users start in `FORCE_CHANGE_PASSWORD`; the
  operator sets a permanent password out-of-band with `aws cognito-idp
  admin-set-user-password --permanent` (runbook). This keeps the authorized-user
  list declarative/repeatable in code while keeping secrets out of state
  (consistent with the FLAG 5 posture).

**The required scope is `aws.cognito.signin.user.admin`** — the scope Cognito puts
on **every** access token minted via `USER_PASSWORD_AUTH`. Setting
`COGNITO_REQUIRED_SCOPE` to it means we need **no resource server and no custom
scopes** — the leanest config that still satisfies the app's mandatory scope check
(`aws-jwt-verify` verifies the `scope` claim contains it). Custom scopes only
appear on tokens obtained via OAuth/hosted-UI flows, which we deliberately avoid.

**How a client obtains the Bearer token** (no hosted UI):

    aws cognito-idp initiate-auth \
      --auth-flow USER_PASSWORD_AUTH \
      --client-id <app_client_id> \
      --auth-parameters USERNAME=<email>,PASSWORD=<password> \
      --region <aws_region>
    # → AuthenticationResult.AccessToken → send as:  Authorization: Bearer <token>

`initiate-auth` goes directly to `cognito-idp.<region>.amazonaws.com` over **HTTPS**
(not through our ALB), so credentials and token issuance are TLS-protected; only
the resulting access token to `/mcp` rides the HTTP ALB (FLAG 7).

**Outputs**: `user_pool_id` (→ `COGNITO_USER_POOL_ID`), `app_client_id`
(→ `COGNITO_CLIENT_ID_ALLOWLIST`, single element), and `issuer` / `jwks_uri`
(informational, for the runbook). `COGNITO_REQUIRED_SCOPE` is a **static app
value** (`aws.cognito.signin.user.admin`) set directly in the service env — not a
Cognito resource. **No `COGNITO_REGION`**: `aws-jwt-verify` derives the region from
the pool id (confirmed by the comment in `src/config/index.ts`).

**Alternatives considered**:
- **Manual console user creation** — rejected: not declarative; the authorized
  list would live outside code. `aws_cognito_user` (no password) captures the list
  in Terraform without any state-secret cost.
- **Resource server + custom scope** (e.g. `lpms-api/invoke`) — rejected (YAGNI):
  forces OAuth/hosted-UI token issuance to mint a token that carries the custom
  scope; `aws.cognito.signin.user.admin` satisfies the check for free.
- **Confidential client + client secret** — rejected: adds a secret to distribute
  and protect for zero pilot benefit; the JWT is the credential.

### Decision: Networking — Fargate in public subnet, no NAT, no endpoints

**Choice**: Public subnets host the ALB **and** the Fargate task
(`assign_public_ip = ENABLED`). The task SG allows inbound only from the ALB SG on
:3000 and unrestricted egress; the task reaches ECR, Bedrock, Secrets Manager, and
CloudWatch Logs over the IGW. RDS lives in private subnets, `publicly_accessible =
false`, SG open only to the Fargate SG on :5432.

**Alternatives considered**:
- **NAT gateway** (task in private subnet, egress via NAT) — rejected: ~**$32/mo**
  fixed + $0.045/GB. Cleanest isolation but the single biggest avoidable cost for a
  pilot.
- **Interface VPC endpoints** (ecr.api, ecr.dkr, logs, secretsmanager,
  bedrock-runtime + S3 gateway) — rejected: 5 interface endpoints ≈ **$36/mo**,
  *more* than NAT here, for a benefit (no internet egress) the pilot does not need.
- **Public-subnet + locked SG** (chosen) — ~**$3.6/mo** for one public IPv4, no
  fixed egress charge. Task has a public IP but is **not reachable inbound** except
  from the ALB SG. RDS remains fully private. Cheapest reachable pattern.

**Single-AZ posture** (FLAG 2): 2 public + 2 private subnets across 2 AZs because
ALB and the RDS DB subnet group each demand ≥2 AZs; subnets are free. Runtime stays
single-AZ: one task, single-AZ RDS, no standby.

### Decision: State backend bootstrap ordering (chicken-and-egg)

**Choice**: `terraform/bootstrap/` uses **local state** (no `backend` block) to
create the S3 bucket + DynamoDB table with **deterministic names** (from variables,
e.g. `lpms-pilot-tfstate-<suffix>` / `lpms-pilot-tflock`). `terraform/envs/pilot/`
declares a **partial** `backend "s3" {}` and is initialized with
`terraform init -backend-config=backend.hcl` (the `backend.hcl` holds only
non-secret names: bucket, key, region, dynamodb_table — safe to commit).

Two-step apply (runbook):
1. `cd terraform/bootstrap && terraform init && terraform apply`
2. `cd terraform/envs/pilot && terraform init -backend-config=backend.hcl && terraform apply`

**Alternatives considered**: migrating the bootstrap state into the new bucket
after creation — rejected for the pilot (extra `init -migrate-state` step, more
runbook surface). Bootstrap state stays local; the operator retains it. Loss is
recoverable via `terraform import` because names are deterministic and
`force_destroy` is off. Documented in the README.

### Decision: RDS + pgvector

**Choice**: `db.t4g.micro`, `engine = postgres`, `engine_version = "16"`,
`allocated_storage = 20`, `storage_type = "gp3"`, `storage_encrypted = true`
(default `aws/rds` KMS key — no CMK for YAGNI), `multi_az = false`,
`publicly_accessible = false`, DB subnet group across the 2 private subnets, SG
inbound :5432 from the Fargate SG only, `skip_final_snapshot = true`,
`deletion_protection = false` (pilot; flagged as hardening flips).

**Credentials**: `random_password` (length 32, exclude URL-hostile chars) →
assembled into a `DATABASE_URL` value → stored as a JSON Secrets Manager secret
`lpms/pilot/app`. Password therefore exists in pilot state (FLAG 5) — mitigations
listed above. Outputs referencing it are `sensitive = true`; no plaintext output.

**Migrations + `CREATE EXTENSION vector`**: run as a **one-off ECS task**
(`aws ecs run-task`) reusing the app image with `command` override
`["node","dist/db/migrate.js"]`, in a public subnet with a public IP so it reaches
RDS. Key facts driving this:
- The **RDS master user has `rds_superuser`**, which is sufficient to
  `CREATE EXTENSION vector` (pgvector is an RDS trusted extension). No separate
  superuser is provisioned — migrations run as the master user.
- `src/db/migrate.ts` wraps **each file in its own `BEGIN/COMMIT`**. Migration
  `0005_embeddings.sql` uses plain `CREATE INDEX ... USING hnsw` (**no
  `CONCURRENTLY`**), which is correct inside a transaction; `CONCURRENTLY` would
  fail there. No design change needed.
- **Run `migrate` ONLY — do NOT run `seed`.** The local compose runs
  `migrate.js && seed.js`; `seed.ts` inserts a dev machine_credential/demo session
  and must not touch pilot RDS.
- **The migrate run-task override needs only `DATABASE_URL` (secret) +
  `NODE_ENV=production` (image default) + `NODE_EXTRA_CA_CERTS`.** `migrate.ts`
  does **not** call `loadConfig()` (it reads `DATABASE_URL`/`NODE_ENV` directly),
  so it needs **no** `COGNITO_*` / `BEDROCK_*` / `GITHUB_OIDC_AUDIENCE` vars — but
  it **does** enforce SSL under production (line 29), so it needs the CA bundle
  trust exactly like the service (see "Decision: RDS TLS trust under production").
- **Gate-2 provisioning is a separate manual SQL step** (no seed): insert the
  `repos`, `app_user` (`idp_subject` = each Cognito `sub`), and `project_membership`
  rows so authenticated users can actually read/stage. Documented in the runbook.

**Ordering**: run the migrate task before scaling the service to serving (or right
after first deploy); `/health` is a liveness check and does not gate on schema, so
the service can start first but tools will error until migrations complete.

**Alternatives considered**: `manage_master_user_password = true` (RDS-managed
rotating secret, password never in state) — rejected for the pilot because the app
needs a single `DATABASE_URL` string; assembling it from the RDS-managed
`{username,password}` secret would either re-introduce the password into state via
a data source or require an app change. Noted as the hardening upgrade.

### Decision: RDS TLS trust under production (`NODE_EXTRA_CA_CERTS`)

**Choice**: Under `NODE_ENV=production` both the service (`src/index.ts:53`) and the
one-off migrate task (`src/db/migrate.ts:29`) call `createPool(url, true)`, which
sets `ssl: { rejectUnauthorized: true }` — verifying the RDS server certificate
against the process trust store. The **Amazon RDS CA is not in the
`node:22-alpine` default trust store**, so a naive connect would fail the TLS
handshake, and `pool.ts` hardcodes the ssl object with **no CA argument**. We
resolve this **without touching `pool.ts`**:

1. **Bake the RDS global CA bundle into the image** (Dockerfile): fetch
   `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` at build
   time to a fixed path, e.g. `/etc/ssl/certs/rds-global-bundle.pem`.
2. **Set `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem`** as a task env
   var — Node adds it to the default trust store at startup, so
   `rejectUnauthorized: true` now verifies the RDS cert. **Set it on BOTH** the
   service task def AND the migrate run-task override (both run under production
   and both enforce SSL).
3. **`DATABASE_URL` stays a plain URL.** The explicit ssl object already mandates
   TLS regardless of `sslmode`; `NODE_EXTRA_CA_CERTS` only supplies trust. No
   `sslmode` param needed (harmless if added).
4. **`rds.force_ssl = 1`** via a **custom DB parameter group** (data module) as
   defense-in-depth — the server itself then rejects any plaintext connection.
   Both the service and migrate use TLS, so this does not break boot or migrations.
   Zero cost. Together with (1)–(3) this flips **FLAG 4 to RESOLVED**.

**Alternatives considered**:
- **Pass `ssl: { ca }` in `pool.ts`** — rejected: a code change to a shared module
  for a deploy-time concern; `NODE_EXTRA_CA_CERTS` is the standard code-free Node
  mechanism and keeps `pool.ts` untouched.
- **`rejectUnauthorized: false`** — rejected: defeats MITM protection, which is the
  entire point of the prod guard.

### Decision: ECS task definition + IAM roles (least privilege)

**Choice**: Fargate task, `cpu = 256` / `memory = 512` (variables; bump to
512/1024 if OOM), `awslogs` driver → dedicated CloudWatch log group
`/lpms/pilot/app`, container port 3000.

- **Execution role**: managed `AmazonECSTaskExecutionRolePolicy` (ECR pull + Logs)
  + inline `secretsmanager:GetSecretValue` scoped to the `lpms/pilot/app` secret
  ARN. No KMS statement needed (default AWS-managed secret key).
- **Task role**: least-privilege Bedrock only — `bedrock:InvokeModel` (Titan
  embed) + `bedrock:Converse` (Haiku judge) on the ARNs in `var.bedrock_model_arns`
  (FLAG 6: include the inference-profile ARN + its constituent foundation-model
  ARNs if a `us.` profile is used). No other permissions.
- **`secrets`**: `DATABASE_URL` via
  `valueFrom = "<secretArn>:DATABASE_URL::"` (Secrets Manager JSON-key syntax).
- **`environment`** (non-secret): `NODE_ENV=production` (image default — kept, NOT
  overridden), `PORT=3000`, `HOST=0.0.0.0`, `LOG_LEVEL=info`,
  `AWS_REGION=us-east-1`, `AUTH_DEV_BYPASS=false`, `PROMOTE_OIDC_DEV_BYPASS=false`,
  `JUDGE_STUB=false`, `EMBEDDER_STUB=false`, `BEDROCK_MODEL_ID=<haiku id>`,
  `BEDROCK_EMBEDDING_MODEL_ID=amazon.titan-embed-text-v2:0`,
  `COGNITO_USER_POOL_ID=<cognito module output>`,
  `COGNITO_CLIENT_ID_ALLOWLIST=<app client id output>`,
  `COGNITO_REQUIRED_SCOPE=aws.cognito.signin.user.admin`,
  `GITHUB_OIDC_AUDIENCE=<placeholder — /promote unused this pilot>`,
  `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem`. None of these are
  secrets (the Cognito app client has no secret; pool/client ids are not
  sensitive), so all live in `environment`; only `DATABASE_URL` is a Secrets
  Manager `secrets` entry.

`EMBEDDING_DIM` is a hardcoded `1024` (not an env var) matched by `vector(1024)` in
migration 0005 — a deploy-time assumption tied to Titan v2, documented in the
README, not a tunable.

### Decision: DNS + TLS (Route53 + ACM) — new `modules/dns-tls`

**Choice**: A new **`modules/dns-tls`** provisions the domain + certificate layer,
kept minimal (one cert, one domain, no wildcard, no CloudFront, no WAF):

- **ACM certificate** for `var.domain_name`, **DNS-validated**
  (`validation_method = "DNS"`). `aws_acm_certificate` + one `aws_route53_record`
  per `domain_validation_options` (the validation CNAME) + `aws_acm_certificate_validation`
  that blocks until the cert is `ISSUED`. **The cert is created in the SAME region
  as the ALB (us-east-1)** — an ALB requires its ACM cert in its own region (this is
  NOT the CloudFront rule that forces us-east-1; here it is simply "same region as
  the ALB", which happens to be us-east-1). The default provider region covers it —
  **no second `us-east-1` provider alias is needed** because the whole pilot is
  us-east-1.
- **Route53 hosted zone**: two paths via `var.create_hosted_zone` (bool, default
  `false`):
  - **default (`false`)** — look up an **existing** parent zone with
    `data "aws_route53_zone"` keyed by `var.route53_zone_name` (e.g.
    `example-fake.dev`). No zone is created; records are written into it.
  - **`true`** — create the zone (`aws_route53_zone`) and **output its
    `name_servers`** so the operator can complete **NS delegation at the registrar**
    (runbook step) before ACM DNS validation can succeed.
- **ALIAS records**: the **A and AAAA alias** for `var.domain_name` → the ALB are
  created in `modules/service` (they need the ALB's `dns_name` + `zone_id`), with
  the hosted-zone id passed in from this module. Co-locating the alias with the ALB
  avoids a module dependency cycle (see Data Flow). This module owns only the zone
  (lookup/create), the cert, and the validation records.

**Outputs**: `certificate_arn` (→ service HTTPS listener), `zone_id` (→ service
alias records), and `name_servers` (informational; populated only when
`create_hosted_zone = true`, for the delegation runbook).

**Why a dedicated module (vs. folding into service/root)**: the cert + validation
have **no dependency on the ALB**, while the alias records **do**. Putting cert +
zone in `dns-tls` and the alias in `service` gives a clean one-directional
dependency (`service` depends on `dns-tls`) with **no cycle**. Folding everything
into `service` would mix a slow, out-of-band concern (DNS-validation wait) into the
compute module; a dedicated module keeps that boundary crisp and matches the
existing one-shape-per-module layout (`network`/`data`/`cognito`).

**Alternatives considered**:
- **Wildcard cert (`*.example-fake.dev`)** — rejected (YAGNI): the pilot answers on
  exactly one FQDN; a single-name cert is narrower and simpler.
- **CloudFront in front of the ALB (cert on the distribution)** — rejected: adds a
  CDN, a us-east-1-only cert rule, and cost for zero pilot benefit; the ALB
  terminates TLS directly.
- **`EMAIL` validation** — rejected: not automatable, needs a monitored mailbox on
  the domain; DNS validation is hands-off and renews automatically.
- **Second `us-east-1` provider alias** — rejected as unnecessary: the pilot is
  already us-east-1, so the default provider issues the ALB cert correctly.

### Decision: ALB (HTTPS with :80 → :443 redirect)

**Choice**: internet-facing ALB across the 2 public subnets. **Two listeners:**
- **:443 HTTPS** — `ssl_policy = "ELBSecurityPolicy-TLS13-1-2-2021-06"` (modern
  TLS 1.3/1.2 policy), `certificate_arn` from `modules/dns-tls`, default action
  **forward** to the target group (`target_type = ip`, port 3000, protocol HTTP —
  TLS terminates at the ALB; the task still speaks plain HTTP on :3000). Health
  check path **`/health`**, matcher 200 — **unchanged**.
- **:80 HTTP** — default action **`redirect`** to `HTTPS:443`, `status_code =
  "HTTP_301"`. **No more plaintext forwarding to the task.**

**SG**: inbound **:443 AND :80** from `var.alb_ingress_cidrs` (:80 is kept only so
the 301 redirect works; no application traffic is served on it). See OPEN #2 for
the allowlist-vs-`0.0.0.0/0` posture — default recommendation is to **keep the
allowlist**.

**FLAG 7 — RESOLVED**: with TLS termination on :443 and the :80→:443 redirect, the
Cognito access token travels **encrypted end-to-end** client→ALB. The
cleartext-Bearer exposure is eliminated. The short 15-min token TTL is retained as
hygiene, not as the transport-security control.

**Alternatives considered**:
- **Keep HTTP-only (previous revision)** — rejected by user decision: ship TLS now so
  the pilot is fully hardened for tokens ("dejamos todo listo").
- **Redirect via a fixed-response / listener rule instead of the listener default
  action** — rejected: the built-in `redirect` default action on the :80 listener is
  the idiomatic, rule-free way to do a blanket 301.
- **Skipping the ALB and hitting the task's public IP** — rejected: no stable DNS, no
  TLS termination point, no health-based routing; the ~$17/mo ALB is justified.

### Decision: App impact of TLS termination (NO app code change)

**Choice**: Adding HTTPS is **entirely an infrastructure change** — **zero app code
changes**. TLS terminates at the ALB; the ALB forwards **plain HTTP to the task on
:3000** exactly as before, so `src/index.ts` still `listen`s on HTTP :3000 and the
**`/health` check is unchanged** (still HTTP, matcher 200). The task is unaware TLS
exists. No `NODE_ENV`, env-var, or Dockerfile change is required for this layer
(the RDS-CA/`NODE_EXTRA_CA_CERTS` work from FLAG 4 is independent and stays).

**Client-facing change (config only):** the pilot endpoint moves from the ALB DNS
name over HTTP to **`https://<domain_name>/mcp`**. The MCP client config
(`.mcp.json`, currently `http://localhost:3000/mcp` for local dev) should point its
`url` at the HTTPS domain for the pilot — this is a **per-operator runbook note**,
not a committed change (the local-dev config stays localhost, and `domain_name` is
still an OPEN input). `.mcp.json` is therefore **not** in the file-change matrix.

**Rationale**: terminating TLS at the ALB is the standard AWS pattern and keeps the
container's contract stable — the same image that runs locally over HTTP runs
unchanged behind the ALB, which is the whole point of the pilot.

### Decision: Provider & version pins

`terraform >= 1.9.0`; `hashicorp/aws ~> 5.70` (v5 line, pinned major to avoid v6
surprises); `hashicorp/random ~> 3.6`. `.terraform.lock.hcl` is **committed** in
both roots to pin provider hashes. Default provider `region = var.aws_region`
(`us-east-1`), `default_tags` stamping `Project=lpms`, `Env=pilot`.

### Decision: Verify strategy for THIS change (apply is out-of-band)

The worker CAN gate on (no AWS creds required):
- `terraform fmt -check -recursive` over `terraform/`.
- Per root (`bootstrap`, `envs/pilot`): `terraform init -backend=false` then
  `terraform validate`. `-backend=false` skips S3 backend init; provider download
  still needs **network** (not AWS creds). Validating the pilot root also validates
  the five modules it calls (`network`, `data`, `cognito`, `dns-tls`, `service`).
- `tflint` if present (optional; not a hard gate).

The worker MUST NOT run `terraform plan`/`apply` — both need AWS credentials and
are human/CI steps documented in the README runbook.

---

## Data Flow

**Token acquisition (out-of-band, over HTTPS to AWS — not our ALB):**

    client ──HTTPS──► cognito-idp.<region>.amazonaws.com
      aws cognito-idp initiate-auth USER_PASSWORD_AUTH → AccessToken (scope: aws.cognito.signin.user.admin)

**Request path (pilot, REAL Cognito Gate 1 over HTTPS — FLAG 7 RESOLVED):**

    client ── DNS ──► domain_name  (Route53 ALIAS A/AAAA → ALB)
          │
          │  :80 HTTP  ─── 301 redirect ──►  :443 HTTPS
          ▼
    Internet (alb_ingress_cidrs only, or 0.0.0.0/0 per OPEN #2)
          │  :443 HTTPS (TLS1.3/1.2, ACM cert)   Authorization: Bearer <JWT> (+ X-Git-Remote)
          ▼
    [ ALB ]  public subnets (2 AZs), SG :443+:80 ← allowlist · TLS terminates here
          │  :3000 HTTP, SG ← ALB SG  (plain HTTP inside the VPC, task unchanged)
          ▼
    [ Fargate task ]  public subnet, public IP (egress only)
      │  Gate 1: verify JWT vs Cognito JWKS  │  Gate 2 + tenant: RDS lookups
      │  reads DATABASE_URL secret           │  bedrock:InvokeModel / Converse
      ▼           (TLS, NODE_EXTRA_CA_CERTS)  ▼
    [ RDS pg16 + pgvector ]                [ Bedrock (Titan v2 + Haiku) ]
      private subnets, SG :5432 ← Fargate SG · rds.force_ssl=1
    (Cognito JWKS, ECR pull, Secrets Manager, CloudWatch Logs all via IGW egress)

**Module dependency (no cycle):** `dns-tls` (zone + ACM cert + validation) →
outputs `certificate_arn` + `zone_id` → `service` (HTTPS listener uses the cert;
A/AAAA alias records use the zone_id + the ALB it creates). The alias lives in
`service` precisely so `dns-tls` never needs the ALB back, keeping the dependency
one-directional.

**Bootstrap + deploy/migrate path (out-of-band, human/CI):**

    terraform/bootstrap (local state) ──► S3 state bucket + DynamoDB lock
          │
          ▼
    terraform/envs/pilot init -backend-config=backend.hcl ──► adopts S3 backend
          │  apply
          ▼
    push image ──► ECR
          │
          ▼
    aws ecs run-task (cmd override: node dist/db/migrate.js)  # migrate ONLY, no seed
          │  CREATE EXTENSION vector (master user = rds_superuser)
          │  (run-task env: DATABASE_URL + NODE_EXTRA_CA_CERTS; no COGNITO_*/BEDROCK_*)
          ▼
    cognito: admin-set-user-password --permanent  (per authorized user)
          │
          ▼
    manual SQL: insert repos + app_user(idp_subject=<cognito sub>) + project_membership  (Gate 2)
          │
          ▼
    service desired_count = 1 ──► task serves /health, /mcp
          │
          ▼
    client → https://<domain_name>/mcp   (TLS-terminated at the ALB; :80 → 301 :443)

    (During apply: aws_acm_certificate_validation blocks until the cert is ISSUED;
     if create_hosted_zone=true, complete NS delegation at the registrar FIRST —
     otherwise DNS validation never resolves. See runbook.)

---

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `terraform/bootstrap/main.tf` | Create | S3 state bucket (versioning, SSE, public-access-block, deterministic name) + DynamoDB lock table. |
| `terraform/bootstrap/variables.tf` | Create | `aws_region`, bucket/table name inputs, name suffix. |
| `terraform/bootstrap/outputs.tf` | Create | Bucket + table names/ARNs (feed `backend.hcl`). |
| `terraform/bootstrap/versions.tf` | Create | `required_version >= 1.9.0`, aws `~> 5.70`. Local backend (no block). |
| `terraform/bootstrap/.terraform.lock.hcl` | Create | Committed, pinned provider hashes. |
| `terraform/modules/network/main.tf` | Create | VPC, IGW, 2 public + 2 private subnets (2 AZs), route tables, ALB SG (**inbound :443 AND :80 from `alb_ingress_cidrs`** — :80 only for the 301 redirect), Fargate SG, RDS SG. |
| `terraform/modules/network/variables.tf` | Create | CIDRs, `aws_region`, `alb_ingress_cidrs` (no default). |
| `terraform/modules/network/outputs.tf` | Create | VPC id, subnet ids, SG ids. |
| `terraform/modules/data/main.tf` | Create | `random_password`, `DATABASE_URL` assembly, Secrets Manager secret, DB subnet group, RDS `db.t4g.micro` pg16 gp3 private, **custom DB parameter group with `rds.force_ssl=1`**. |
| `terraform/modules/data/variables.tf` | Create | Instance class, storage, engine version, subnet/SG ids, secret name, **parameter-group family (`postgres16`)**. |
| `terraform/modules/data/outputs.tf` | Create | RDS endpoint, secret ARN (all `sensitive`). |
| `terraform/modules/cognito/main.tf` | Create | User pool (`allow_admin_create_user_only`, `username_attributes=["email"]`, password policy), app client (public, `ALLOW_USER_PASSWORD_AUTH`+`ALLOW_REFRESH_TOKEN_AUTH`, short TTLs), `aws_cognito_user` `for_each` authorized emails (`message_action=SUPPRESS`, NO password). |
| `terraform/modules/cognito/variables.tf` | Create | `authorized_user_emails` (`list(string)`), pool/client name inputs, token TTL minutes. |
| `terraform/modules/cognito/outputs.tf` | Create | `user_pool_id`, `app_client_id`, `issuer`, `jwks_uri` (informational). No client secret, no region output. |
| `terraform/modules/dns-tls/main.tf` | Create | Route53 zone (`data aws_route53_zone` when `create_hosted_zone=false`; `aws_route53_zone` when `true`), `aws_acm_certificate` (`domain_name`, DNS validation), `aws_route53_record` for each validation CNAME, `aws_acm_certificate_validation`. **Cert region = ALB region = us-east-1 (default provider — no alias).** |
| `terraform/modules/dns-tls/variables.tf` | Create | `domain_name`, `route53_zone_name`, `create_hosted_zone` (bool, default `false`). |
| `terraform/modules/dns-tls/outputs.tf` | Create | `certificate_arn` (→ service listener), `zone_id` (→ service alias), `name_servers` (informational; set only when `create_hosted_zone=true`, for NS delegation). |
| `terraform/modules/service/main.tf` | Create | ECR repo, ECS cluster, task def, service, ALB + target group + **HTTPS :443 listener (ACM cert, `ELBSecurityPolicy-TLS13-1-2-2021-06`) + :80 listener as HTTP_301 redirect to :443** + **A/AAAA alias records (`domain_name` → ALB, into `route53_zone_id`)**, execution + task IAM roles, CloudWatch log group. **Prod env block** (bypass flags `=false`, `COGNITO_*`, `GITHUB_OIDC_AUDIENCE` placeholder, `NODE_EXTRA_CA_CERTS`). |
| `terraform/modules/service/variables.tf` | Create | Image URI/tag, cpu/memory, `desired_count`, subnet/SG ids, secret ARN, `bedrock_model_arns`, model ids, `cognito_*`, `github_oidc_audience`, `node_extra_ca_certs`, **`certificate_arn`, `route53_zone_id`, `domain_name`** (bypass/stub flags fixed to `false`/prod). |
| `terraform/modules/service/outputs.tf` | Create | ALB DNS name, **ALB `zone_id`** (for alias), **`pilot_url` = `https://<domain_name>/mcp`**, ECR repo URL, service/cluster names, log group. |
| `terraform/envs/pilot/main.tf` | Create | Wires network → data → **cognito** → **dns-tls** → service (service consumes cognito + dns-tls outputs: `certificate_arn`, `zone_id`); provider `default_tags`. |
| `terraform/envs/pilot/variables.tf` | Create | Root inputs (region, CIDRs, `alb_ingress_cidrs`, image tag, model ids/ARNs, sizing, `desired_count`, `authorized_user_emails`, `github_oidc_audience` placeholder, **`domain_name`, `route53_zone_name`, `create_hosted_zone`**). |
| `terraform/envs/pilot/outputs.tf` | Create | **`pilot_url` (`https://<domain_name>/mcp`)**, ALB DNS, ECR URL, run-task/migrate helper values, `cognito_user_pool_id`, `cognito_app_client_id`, `cognito_issuer`, **`route53_name_servers`** (for NS delegation when `create_hosted_zone=true`). |
| `terraform/envs/pilot/versions.tf` | Create | Version pins + partial `backend "s3" {}`. |
| `terraform/envs/pilot/backend.hcl` | Create | Non-secret backend config (bucket, key, region, dynamodb_table). Committed. |
| `terraform/envs/pilot/pilot.tfvars.example` | Create | Example values incl. placeholder `alb_ingress_cidrs`, model ids/ARNs, `authorized_user_emails` (clearly-fake example only, e.g. `you@<COMPANY_DOMAIN>`), `github_oidc_audience` placeholder, **`domain_name = "lpms-pilot.example-fake.dev"`, `route53_zone_name = "example-fake.dev"`, `create_hosted_zone = false`** (CLEARLY-FAKE domain). No secrets, **no real emails/domains**. |
| `Dockerfile` | Modify | Fetch the RDS global CA bundle to `/etc/ssl/certs/rds-global-bundle.pem` at build so `NODE_EXTRA_CA_CERTS` can trust RDS under `NODE_ENV=production`. No other change (image already defaults `NODE_ENV=production`). |
| `terraform/envs/pilot/.terraform.lock.hcl` | Create | Committed, pinned provider hashes. |
| `terraform/README.md` | Create | Runbook: bootstrap → init pilot → **(if `create_hosted_zone=true`) apply, read `route53_name_servers`, delegate NS at the registrar, wait for propagation** → apply (ACM DNS validation blocks until ISSUED) → push image → run-task migrate (NOT seed) → `admin-set-user-password` → Gate-2 SQL → desired_count=1 → **client points at `https://<domain_name>/mcp`**; verify (`fmt`/`validate`); cost + FLAGS summary. |
| `.gitignore` | Modify | Add Terraform ignores (see below); keep `.terraform.lock.hcl` and `backend.hcl` committed. |
| `openspec/project-map.yaml` | Modify | Flip `deferred_next: AWS infra (…terraform-infra NEXT)` to reflect the pilot topology this change delivers (single-AZ, no NAT, **real-Cognito production pilot, TLS-terminated via Route53 + ACM (HTTPS)**; only **real GitHub-OIDC `/promote`** deferred to hardening). |

**`.gitignore` additions** (FLAG-safe; examples use `*.tfvars.example`, which
`*.tfvars` does not match, so no negation needed):

    # Terraform
    **/.terraform/*
    *.tfstate
    *.tfstate.*
    *.tfvars
    *.tfvars.json
    crash.log
    crash.*.log
    override.tf
    override.tf.json
    *_override.tf
    *_override.tf.json
    # KEEP committed (do NOT ignore): .terraform.lock.hcl, backend.hcl, *.tfvars.example

**Tasks-friendly ordering** (each step independently `validate`-able):
1. `.gitignore` additions (prevents accidental state/tfvars commits from step 2 on).
2. `terraform/bootstrap/*` (state backend) + commit its lock file.
3. `terraform/modules/network/*`.
4. `terraform/modules/data/*` (depends on network SG/subnet outputs; adds the
   `rds.force_ssl` parameter group).
5. `terraform/modules/cognito/*` (no VPC dependency — regional service; can land
   in parallel with network/data).
6. `terraform/modules/dns-tls/*` (no VPC dependency — Route53/ACM are regional;
   can land in parallel with cognito/network/data). **The ACM cert + validation
   must exist before the service's HTTPS listener** — enforced by the module
   dependency (`service` consumes `certificate_arn`).
7. `terraform/modules/service/*` (depends on network + data + **cognito** +
   **dns-tls** outputs; HTTPS :443 listener uses `certificate_arn`, :80→:443 301
   redirect, A/AAAA alias uses `zone_id` — the alias can only be created **once the
   ALB exists**, which is why it lives here).
8. `terraform/envs/pilot/*` (wires 3→7; backend.hcl; example tfvars incl.
   `authorized_user_emails`, `github_oidc_audience`, **`domain_name` /
   `route53_zone_name` / `create_hosted_zone`**; lock file).
9. `Dockerfile` — add the RDS CA bundle (independent of Terraform; needed before
   the image is built for deploy).
10. `terraform/README.md` runbook (bootstrap → **[if creating zone: apply, delegate
    NS at registrar, wait]** → apply with ACM DNS-validation wait → push image →
    run-task migrate → `admin-set-user-password --permanent` → manual Gate-2 SQL →
    `desired_count=1` → `initiate-auth` token → call **`https://<domain_name>/mcp`**).
11. `openspec/project-map.yaml` update.
12. Gate: `terraform fmt -check -recursive` + `init -backend=false && validate` per
    root (offline; provider download needs network, not AWS creds). `apply` stays
    human/CI, out-of-band — unchanged.
