# Spec — terraform-infra (minimal pilot + Cognito + HTTPS)

Authoritative implementation detail lives in `design.md` (file matrix, exact
resource config, ordering). These are the outcome requirements.

## Requirements

### REQ-01 — Two-root Terraform, S3 backend
`terraform/bootstrap/` (local state) creates a versioned, SSE-encrypted,
public-access-blocked S3 state bucket + DynamoDB lock table. `terraform/envs/pilot/`
uses a partial `backend "s3" {}` initialized from a committed non-secret `backend.hcl`.

### REQ-02 — Single-AZ cost posture, no NAT
New VPC with 2 public + 2 private subnets across 2 AZs (ALB + RDS subnet group each
need ≥2 AZs), IGW, route tables. Runtime single-AZ: 1 Fargate task, single-AZ RDS,
NO NAT gateway, NO VPC interface endpoints. Fargate runs in a public subnet with a
public IP; its SG allows inbound only from the ALB SG.

### REQ-03 — ECR + ECS Fargate service
One private ECR repo. ECS cluster + Fargate service (`desired_count` variable)
running the existing `node:22-alpine` app image on container port 3000. Execution
role: ECR pull + CloudWatch Logs + `secretsmanager:GetSecretValue` scoped to the app
secret. Task role: least-privilege Bedrock only (`bedrock:InvokeModel` +
`bedrock:Converse`) on `var.bedrock_model_arns`.

### REQ-04 — RDS Postgres 16 + pgvector, private, TLS-enforced
`db.t4g.micro`, pg16, 20GB gp3, encrypted, single-AZ, `publicly_accessible=false`,
DB subnet group in the private subnets, SG inbound :5432 from the Fargate SG only.
Custom DB parameter group with `rds.force_ssl=1`. Credentials: `random_password` →
assembled `DATABASE_URL` → Secrets Manager (sensitive outputs; never committed).
Migrations (incl. `CREATE EXTENSION vector`) run as a one-off `ecs run-task` with
`command` override `node dist/db/migrate.js` (migrate ONLY, never seed); master user
has `rds_superuser`.

### REQ-05 — Production config, real Bedrock, no bypass
The task runs `NODE_ENV=production` with `AUTH_DEV_BYPASS=false`,
`PROMOTE_OIDC_DEV_BYPASS=false`, `JUDGE_STUB=false`, `EMBEDDER_STUB=false`. All
required prod vars supplied: `BEDROCK_MODEL_ID`, `BEDROCK_EMBEDDING_MODEL_ID`,
`AWS_REGION`, `COGNITO_*`, `GITHUB_OIDC_AUDIENCE` (placeholder — `/promote` closed
this pilot). `NODE_EXTRA_CA_CERTS` points at a baked RDS CA bundle so app-side RDS
TLS (`rejectUnauthorized:true`) succeeds. Only `DATABASE_URL` is a Secrets Manager
`secrets` entry; the rest are non-secret `environment`.

### REQ-06 — Minimal real Cognito (Gate 1)
`modules/cognito`: one user pool (`allow_admin_create_user_only`, email sign-in,
strong password policy, no hosted UI / no federation / no groups) + one public app
client (`ALLOW_USER_PASSWORD_AUTH` + `ALLOW_REFRESH_TOKEN_AUTH`, no secret, 15-min
access-token TTL). Authorized users via `aws_cognito_user` `for_each` over
`var.authorized_user_emails` with `message_action=SUPPRESS` and NO password in
Terraform. Outputs `user_pool_id` + `app_client_id` wire to `COGNITO_USER_POOL_ID`
+ `COGNITO_CLIENT_ID_ALLOWLIST`; `COGNITO_REQUIRED_SCOPE=aws.cognito.signin.user.admin`.

### REQ-07 — HTTPS end-to-end (Route53 + ACM)
DNS-validated ACM cert in us-east-1 for `var.domain_name`; Route53 record set (ALIAS
to ALB), defaulting to a `data aws_route53_zone` lookup by `var.route53_zone_name`
with an optional `create_hosted_zone` path. ALB: internet-facing across the 2 public
subnets, **:443 HTTPS listener** (validated cert + modern TLS policy) forwarding to
the target group (port 3000, health check `/health`), **:80 listener 301-redirects
to :443**. SG inbound 80+443 from `var.alb_ingress_cidrs` (no default — must be set).

### REQ-08 — No secrets/state committed; providers pinned
`.gitignore` excludes `*.tfstate*`, `.terraform/`, `*.tfvars` (keeps
`*.tfvars.example`, `backend.hcl`, `.terraform.lock.hcl`). Providers pinned
(`terraform>=1.9`, `aws ~>5.70`, `random ~>3.6`); lock files committed. Example
tfvars use a clearly-fake domain and example emails only — no real values.

### REQ-09 — Dockerfile: RDS CA bundle
`Dockerfile` fetches the RDS global CA bundle to
`/etc/ssl/certs/rds-global-bundle.pem` at build time so `NODE_EXTRA_CA_CERTS` can
trust RDS under production. No other app change.

### REQ-10 — Runbook + project-map
`terraform/README.md`: bootstrap → init pilot → apply → push image → run-task migrate
(NOT seed) → `admin-set-user-password --permanent` → manual Gate-2 SQL → set
`desired_count=1` → `initiate-auth` token → call `https://<domain>/mcp`. Update
`openspec/project-map.yaml` to reflect the delivered pilot topology.

## Acceptance Criteria
- `terraform fmt -check -recursive` clean; per-root `terraform init -backend=false
  && terraform validate` clean (bootstrap + pilot; pilot validates its 4 modules).
  If the `terraform` binary is unavailable in the build env, that is reported and
  validation is deferred to human/CI (apply is out-of-band regardless).
- No `apply`/`plan` run by the worker (need AWS creds). No `.tfstate`, real tfvars,
  or secrets created/committed. `.terraform.lock.hcl` + `backend.hcl` ARE committed.
- App is NOT modified except the Dockerfile CA-bundle line.
