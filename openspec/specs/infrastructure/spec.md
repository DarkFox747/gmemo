# Infrastructure Specification

## Purpose

Minimal AWS pilot deployed with Terraform: two roots (state bootstrap and pilot), a single-AZ cost posture without NAT, ECS Fargate behind an HTTPS ALB, private RDS Postgres 16 with pgvector, and a minimal Cognito pool. Physical resource names use the `gmemo-pilot-*` prefix; account, domain, state bucket and similar live values are supplied as placeholders or required variables (`<AWS_ACCOUNT_ID>`, `<DOMAIN>`, `<TFSTATE_BUCKET>`, `<TFLOCK_TABLE>`, `<HOSTED_ZONE_ID>`, `<OPERATOR_IP>`) and are never committed.

## Requirements

### Requirement: Two-root Terraform with S3 backend

`terraform/bootstrap/` (local state) MUST create a versioned, SSE-encrypted, public-access-blocked S3 state bucket (`<TFSTATE_BUCKET>`) and a DynamoDB lock table (`<TFLOCK_TABLE>`). `terraform/envs/pilot/` MUST use a partial `backend "s3" {}` initialized from a committed non-secret `backend.hcl` carrying those placeholders.

Source: terraform-infra

#### Scenario: Backend init

- GIVEN `backend.hcl` filled with real bucket and table names
- WHEN running `terraform init -backend-config=backend.hcl` in the pilot root
- THEN the S3 backend initializes

### Requirement: Single-AZ cost posture, no NAT

A new VPC MUST have 2 public and 2 private subnets across 2 AZs, an IGW and route tables. Runtime MUST be single-AZ: 1 Fargate task and single-AZ RDS, with NO NAT gateway and NO VPC interface endpoints. Fargate MUST run in a public subnet with a public IP and its security group MUST allow inbound only from the ALB security group.

Source: terraform-infra

#### Scenario: Direct access blocked

- GIVEN the deployed task
- WHEN connecting to port 3000 from outside the ALB
- THEN the security group denies it

### Requirement: ECR and ECS Fargate service

There MUST be one private ECR repo and an ECS cluster and Fargate service (`desired_count` variable) running the `node:22-alpine` app image on port 3000. The execution role MUST allow ECR pull, CloudWatch Logs and `secretsmanager:GetSecretValue` scoped to the app secret. The task role MUST be least-privilege Bedrock only (`bedrock:InvokeModel` and `bedrock:Converse`) on `var.bedrock_model_arns`.

Source: terraform-infra

#### Scenario: Scoped roles

- GIVEN the planned IAM policies
- WHEN reviewing them
- THEN secrets access is limited to the app secret and Bedrock actions to the listed model ARNs

### Requirement: Private RDS Postgres 16 with pgvector, TLS enforced

RDS MUST be `db.t4g.micro`, pg16, 20GB gp3, encrypted, single-AZ, `publicly_accessible=false`, in the private-subnet group, with inbound :5432 only from the Fargate security group. A custom parameter group MUST set `rds.force_ssl=1`. Credentials MUST flow `random_password` to an assembled `DATABASE_URL` to Secrets Manager (`gmemo/pilot/app`) as sensitive outputs, never committed. Migrations (including `CREATE EXTENSION vector`) MUST run as a one-off `ecs run-task` with command override `node dist/db/migrate.js` (migrate only, never seed), and the master user MUST have `rds_superuser`.

Source: terraform-infra

#### Scenario: Migrate without seed

- GIVEN the pilot stack
- WHEN running the one-off migrate task
- THEN migrations apply and no dev seed data is inserted

### Requirement: Production config, real Bedrock, no bypass

The task MUST run `NODE_ENV=production` with `AUTH_DEV_BYPASS=false`, `PROMOTE_OIDC_DEV_BYPASS=false`, `JUDGE_STUB=false` and `EMBEDDER_STUB=false`, and supply every required prod variable: `BEDROCK_MODEL_ID`, `BEDROCK_EMBEDDING_MODEL_ID`, `AWS_REGION`, `COGNITO_*` and `GITHUB_OIDC_AUDIENCE`. `NODE_EXTRA_CA_CERTS` MUST point at the baked RDS CA bundle so app-side RDS TLS (`rejectUnauthorized:true`) succeeds. Only `DATABASE_URL` MUST be a Secrets Manager `secrets` entry; the rest are non-secret `environment`.

Source: terraform-infra

#### Scenario: App boots under production guards

- GIVEN the task definition environment
- WHEN the app loads configuration
- THEN every production guard passes and the app starts

### Requirement: Minimal Cognito (Gate 1)

`modules/cognito` MUST define one user pool (`allow_admin_create_user_only`, email sign-in, strong password policy, no hosted UI, federation or groups) and one public app client (`ALLOW_USER_PASSWORD_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH`, no secret, 15-minute access-token TTL). Authorized users MUST come from `aws_cognito_user` `for_each` over `var.authorized_user_emails` with `message_action=SUPPRESS` and no password in Terraform. Outputs `user_pool_id` and `app_client_id` MUST wire to `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID_ALLOWLIST`, with `COGNITO_REQUIRED_SCOPE=aws.cognito.signin.user.admin`.

Source: terraform-infra

#### Scenario: No password in state inputs

- GIVEN the Cognito module
- WHEN reviewing its inputs
- THEN no user password is defined in Terraform

### Requirement: HTTPS end to end

A DNS-validated ACM certificate MUST exist in us-east-1 for `var.domain_name` (`<DOMAIN>`), with a Route53 ALIAS record, defaulting to a `data aws_route53_zone` lookup by `var.route53_zone_name` with an optional `create_hosted_zone` path. The ALB MUST be internet-facing across the 2 public subnets with a :443 HTTPS listener (validated cert, modern TLS policy) forwarding to the target group (port 3000, health check `/health`) and a :80 listener that 301-redirects to :443. Security group inbound 80 and 443 MUST come from `var.alb_ingress_cidrs`, which has no default and must be set.

Source: terraform-infra

#### Scenario: HTTP redirect

- GIVEN the deployed ALB
- WHEN requesting `http://<DOMAIN>/health`
- THEN it returns a 301 to HTTPS

### Requirement: No secrets or state committed, providers pinned

`.gitignore` MUST exclude `*.tfstate*`, `.terraform/` and `*.tfvars` while keeping `*.tfvars.example`, `backend.hcl` and `.terraform.lock.hcl`. Providers MUST be pinned (`terraform>=1.9`, `aws ~>5.70`, `random ~>3.6`) with lock files committed. Example tfvars MUST use a clearly fake domain and example emails only. Live-only values (`account_id`, `github_repo`) MUST be required inputs with no default.

Source: terraform-infra

#### Scenario: Validate offline

- GIVEN each root
- WHEN running `terraform fmt -check -recursive` and `terraform init -backend=false && terraform validate`
- THEN both are clean (or validation is reported as deferred when the binary is unavailable)

### Requirement: Dockerfile RDS CA bundle

The `Dockerfile` MUST fetch the RDS global CA bundle to `/etc/ssl/certs/rds-global-bundle.pem` at build time so `NODE_EXTRA_CA_CERTS` can trust RDS in production.

Source: terraform-infra

#### Scenario: CA present

- GIVEN the built image
- WHEN inspecting `/etc/ssl/certs/`
- THEN `rds-global-bundle.pem` exists

### Requirement: Runbook and project map

`terraform/README.md` MUST document: bootstrap, init pilot, apply, push image, run-task migrate (not seed), `admin-set-user-password --permanent`, manual Gate-2 SQL, set `desired_count=1`, `initiate-auth` token, call `https://<DOMAIN>/mcp`. It MUST warn that applying over an existing pilot replaces RDS, Secrets Manager, ECS, ALB, ECR, the log group and IAM roles. `openspec/project-map.yaml` MUST reflect the delivered pilot topology.

Source: terraform-infra

#### Scenario: Runbook complete

- GIVEN `terraform/README.md`
- WHEN following it from bootstrap to the `/mcp` call
- THEN every step above is documented in order

## History

None.
