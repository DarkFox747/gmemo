# Terraform Runbook — LPMS Pilot

Cheapest-viable single-AZ AWS pilot with real Cognito (Gate 1) and HTTPS
(Route53 + ACM). Runs `NODE_ENV=production` — all bypass flags OFF.

**Apply is performed by a human or CI — never by the worker that authored this code.**

---

## Architecture Overview

```
client ──HTTPS──► cognito-idp.<region>.amazonaws.com  (token acquisition, out-of-band)

client ── DNS ──► domain_name (Route53 ALIAS A/AAAA → ALB)
     :80 HTTP ─── 301 redirect ──► :443 HTTPS
     :443 HTTPS (TLS1.3/1.2, ACM cert)  Authorization: Bearer <Cognito JWT>
          ▼
     [ ALB ]  public subnets (2 AZs) · TLS terminates here
          ▼
     [ Fargate task ]  public subnet, public IP (egress via IGW)
          ▼
     [ RDS pg16 + pgvector ]   private subnets · rds.force_ssl=1
     [ Bedrock Titan v2 + Haiku ]   via IGW egress
```

**Two Terraform roots:**

| Root | State | Purpose |
|------|-------|---------|
| `terraform/bootstrap/` | Local | Creates S3 state bucket + DynamoDB lock table |
| `terraform/envs/pilot/` | S3 backend | Full pilot (network, data, cognito, dns-tls, service) |

**Five modules (in dependency order):**

```
network → data → (cognito, dns-tls) → service
```

---

## Monthly Cost Estimate (~$46/mo, us-east-1)

| Resource | ~$/mo |
|----------|-------|
| ALB | $17 |
| Fargate (0.25 vCPU / 512 MB) | $9 |
| RDS db.t4g.micro 20 GB gp3 | $14 |
| Public IPv4 (1 address) | $3.60 |
| Secrets Manager | $0.40 |
| Route53 hosted zone (if `create_hosted_zone=true`) | $0.50 |
| **Total** | **~$46** |

Cognito is free under 50k MAUs. ACM public certificates are free. No NAT
(saves ~$32/mo). No VPC interface endpoints (saves ~$36/mo).

---

## Prerequisites

- Terraform >= 1.9.0 (`terraform version`)
- AWS CLI v2 configured with credentials for the target account
- An existing Route53 hosted zone for your domain (or set `create_hosted_zone=true`)
- Bedrock model access granted in the target region for:
  - `amazon.titan-embed-text-v2:0`
  - Your chosen judge model (e.g. `anthropic.claude-3-5-haiku-20241022-v1:0`)
- Docker installed for building and pushing the app image

---

## Step 1 — Bootstrap (local state → S3 + DynamoDB)

```bash
cd terraform/bootstrap

# Create a terraform.tfvars (gitignored) with a globally-unique bucket name:
#   state_bucket_name = "lpms-pilot-tfstate-<your-account-id-suffix>"
# OR pass via -var:

terraform init
terraform apply \
  -var="state_bucket_name=lpms-pilot-tfstate-<suffix>"

# Copy the outputs into terraform/envs/pilot/backend.hcl:
terraform output state_bucket_name   # → bucket value
terraform output lock_table_name     # → dynamodb_table value (default: lpms-pilot-tflock)
```

Edit `terraform/envs/pilot/backend.hcl` and replace `CHANGE_ME_AFTER_BOOTSTRAP`
with the actual bucket name from the output above.

**Keep the local `terraform.tfstate` from this root.** If lost, recover via
`terraform import` (resource names are deterministic). Do NOT migrate it to S3.

---

## Step 2 — Configure pilot variables

```bash
cd terraform/envs/pilot
cp pilot.tfvars.example pilot.tfvars   # gitignored — safe to add real values
```

Edit `pilot.tfvars` with real values:
- `alb_ingress_cidrs` — your operator IP CIDR(s), e.g. `["1.2.3.4/32"]`
- `domain_name` — the FQDN the pilot answers on (e.g. `lpms-pilot.yourdomain.dev`)
- `route53_zone_name` — your Route53 hosted zone (e.g. `yourdomain.dev`)
- `authorized_user_emails` — email addresses to provision as Cognito users
- `bedrock_model_id` — your Haiku model ID
- `bedrock_model_arns` — Bedrock model ARNs for the task role (see FLAG 6 note below)
- `github_oidc_audience` — leave as a placeholder; `/promote` is fail-closed this pilot

**FLAG 6 note:** if `bedrock_model_id` is a cross-region inference profile
(e.g. `us.anthropic.claude-3-5-haiku-...`), include the inference-profile ARN
AND each constituent foundation-model ARN in `bedrock_model_arns`.

---

## Step 3 — Init pilot environment

```bash
cd terraform/envs/pilot
terraform init -backend-config=backend.hcl
```

---

## Step 4 — (Only if `create_hosted_zone=true`) Apply, then delegate NS

If you set `create_hosted_zone=true` in `pilot.tfvars`:

```bash
terraform apply -var-file=pilot.tfvars
terraform output route53_name_servers   # returns the 4 NS records
```

Go to your domain registrar and update the NS records for `route53_zone_name`
to the values returned above. **Wait for DNS propagation (minutes to hours)
before proceeding** — ACM DNS validation blocks until the CNAME records resolve.

---

## Step 5 — Apply pilot (ACM DNS validation included)

```bash
terraform apply -var-file=pilot.tfvars
```

Terraform will block on `aws_acm_certificate_validation` until the certificate
reaches `ISSUED` status (DNS validation resolves). This can take 1–5 minutes
if the hosted zone and DNS propagation are already in place.

After a successful apply, collect the outputs:

```bash
terraform output ecr_repository_url        # for Step 6
terraform output ecs_cluster_name          # for Step 7
terraform output ecs_task_definition_family # for Step 7
terraform output public_subnet_ids         # for Step 7
terraform output fargate_sg_id             # for Step 7
terraform output cognito_user_pool_id      # for Step 8
terraform output cognito_app_client_id     # for Step 11
terraform output pilot_url                 # the final endpoint
```

> **Note:** The ECS service is deployed with `desired_count = 0`. It will not
> attempt to pull the container image until Step 10 bumps the count to 1.
> Complete Steps 6 (image push) and 7 (migrations) first to avoid a
> `CannotPullContainerError` retry loop.

---

## Step 6 — Build and push the Docker image

```bash
ECR_URL=$(terraform output -raw ecr_repository_url)
REGION="us-east-1"

# Authenticate Docker to ECR
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ECR_URL"

# Build and push from the repo root
cd "$(git rev-parse --show-toplevel)"
docker build -t lpms-pilot-app .
docker tag lpms-pilot-app:latest "$ECR_URL:latest"
docker push "$ECR_URL:latest"
```

The Dockerfile now includes the RDS global CA bundle at
`/etc/ssl/certs/rds-global-bundle.pem` — required for RDS TLS trust under
`NODE_ENV=production`.

---

## Step 7 — Run database migrations (NOT seed)

Migrations include `CREATE EXTENSION vector` (migration 0005). The RDS master
user has `rds_superuser`, so no separate superuser is needed.

**Run migrate ONLY — do NOT run seed.** The seed inserts dev credentials and
must never touch pilot RDS.

```bash
cd terraform/envs/pilot

CLUSTER=$(terraform output -raw ecs_cluster_name)
FAMILY=$(terraform output -raw ecs_task_definition_family)
SECRET_ARN=$(terraform output -raw secret_arn)
SUBNET_ID=<one-of-the-public-subnet-ids>   # from terraform output or AWS console
FARGATE_SG=<fargate-sg-id>                  # from AWS console / terraform state

aws ecs run-task \
  --cluster "$CLUSTER" \
  --launch-type FARGATE \
  --task-definition "$FAMILY" \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$FARGATE_SG],assignPublicIp=ENABLED}" \
  --overrides '{
    "containerOverrides": [{
      "name": "app",
      "command": ["node", "dist/db/migrate.js"],
      "environment": [
        {"name": "NODE_EXTRA_CA_CERTS", "value": "/etc/ssl/certs/rds-global-bundle.pem"}
      ]
    }]
  }'

# Monitor the task until it exits (exitCode 0 = success):
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks <task-arn>
aws ecs describe-tasks --cluster "$CLUSTER" --tasks <task-arn> \
  | jq '.tasks[0].containers[0].exitCode'   # expect 0
```

The migrate run-task inherits `DATABASE_URL` (from Secrets Manager via the
execution role) and `NODE_EXTRA_CA_CERTS` from the override. It does NOT need
`COGNITO_*` or `BEDROCK_*` vars — `migrate.ts` reads only `DATABASE_URL` and
`NODE_ENV` directly.

---

## Step 8 — Set Cognito user passwords

Users were provisioned in `FORCE_CHANGE_PASSWORD` state (no password in
Terraform). Set a permanent password for each authorized user:

```bash
POOL_ID=$(terraform output -raw cognito_user_pool_id)

for EMAIL in you@<COMPANY_DOMAIN>; do
  aws cognito-idp admin-set-user-password \
    --user-pool-id "$POOL_ID" \
    --username "$EMAIL" \
    --password '<StrongPassword!123>' \
    --permanent
done
```

Password must meet the pool policy: ≥12 chars, upper, lower, digit, symbol.

---

## Step 9 — Gate-2 SQL (manual provisioning)

Cognito authenticates users (Gate 1), but the app also requires Gate-2 rows in
RDS before read/stage tools will work. Connect to the database (via a bastion
or aws-cli RDS Data API) and run:

```sql
-- 1. Register the git remote (the X-Git-Remote header value the client sends)
INSERT INTO repos (id, remote_url, created_at)
VALUES (gen_random_uuid(), 'https://github.com/your-org/your-repo', now());

-- 2. Create the app user (idp_subject = the Cognito sub from the access token)
--    Get the sub: decode the access token JWT payload (base64) or call GetUser.
INSERT INTO app_user (id, idp_subject, email, role, enabled, created_at)
VALUES (gen_random_uuid(), '<cognito-sub-uuid>', 'you@<COMPANY_DOMAIN>', 'contributor', true, now());

-- 3. Create the project row (project_membership has a FK on project.id)
INSERT INTO project (id, slug, name, created_at)
VALUES (gen_random_uuid(), 'lpms-pilot', 'lpms-pilot', now());

-- 4. Create project membership
INSERT INTO project_membership (id, project_id, user_id, role, created_at)
VALUES (gen_random_uuid(), '<project-id>', '<user-id>', 'contributor', now());
```

Until these rows exist, authenticated Cognito users receive an opaque
`PERMISSION_DENIED` — correct fail-closed behavior.

**To get the Cognito `sub`:** after a user signs in (Step 11), decode the
access token JWT: `echo <token> | cut -d. -f2 | base64 -d | jq .sub`

---

## Step 10 — Start the service

The pilot deploys with `desired_count = 0` (the default). Once the image is
pushed (Step 6) and migrations have run successfully (Step 7), bump the count
to 1 to start the service:

```bash
terraform apply -var-file=pilot.tfvars -var="desired_count=1"

# Verify the health check passes:
aws elbv2 describe-target-health \
  --target-group-arn $(aws elbv2 describe-target-groups \
    --names lpms-pilot-tg --query 'TargetGroups[0].TargetGroupArn' --output text)
# Expect: HealthStatus = "healthy"
```

---

## Step 11 — Obtain a Cognito access token

```bash
CLIENT_ID=$(terraform output -raw cognito_app_client_id)

TOKEN_JSON=$(aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id "$CLIENT_ID" \
  --auth-parameters "USERNAME=you@<COMPANY_DOMAIN>,PASSWORD=<your-password>" \
  --region us-east-1)

ACCESS_TOKEN=$(echo "$TOKEN_JSON" | jq -r '.AuthenticationResult.AccessToken')
echo "$ACCESS_TOKEN"   # 15-min TTL
```

Tokens expire after 15 minutes. Use the refresh token to get a new one:

```bash
REFRESH_TOKEN=$(echo "$TOKEN_JSON" | jq -r '.AuthenticationResult.RefreshToken')
aws cognito-idp initiate-auth \
  --auth-flow REFRESH_TOKEN_AUTH \
  --client-id "$CLIENT_ID" \
  --auth-parameters "REFRESH_TOKEN=$REFRESH_TOKEN" \
  --region us-east-1 \
  | jq -r '.AuthenticationResult.AccessToken'
```

---

## Step 12 — Test the MCP endpoint

```bash
PILOT_URL=$(terraform output -raw pilot_url)   # https://<domain>/mcp

# Health check (no auth)
curl -s "https://<domain>/health"   # expect: {"status":"ok"}

# recall tool (requires Gate-1 token + Gate-2 rows from Step 9)
curl -s -X POST "$PILOT_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Git-Remote: https://github.com/your-org/your-repo" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recall","arguments":{"query":"test"}}}'
```

---

## Day-2 Operations

### Enable MFA for a user

The Cognito pool is configured with `mfa_configuration = "OPTIONAL"` (TOTP, no SES/SMS cost).
To enforce MFA for a specific user after they have enrolled their authenticator app:

```bash
aws cognito-idp admin-set-user-mfa-preference \
  --software-token-mfa-settings Enabled=true,PreferredMfa=true \
  --user-pool-id "$POOL_ID" \
  --username "operator@example.com"
```

---

### Deploy a new image

```bash
docker build -t lpms-pilot-app . && docker push "$ECR_URL:latest"

# Force ECS to pull the new image (Terraform ignores task_definition changes):
aws ecs update-service --cluster lpms-pilot --service lpms-pilot-app --force-new-deployment
```

### Pause the service (zero cost while idle)

```bash
terraform apply -var-file=pilot.tfvars -var="desired_count=0"
```

### View logs

```bash
aws logs tail /lpms/pilot/app --follow
```

### Rotate the DB password

Update Secrets Manager manually and ECS will pick it up on next task launch:

```bash
aws secretsmanager put-secret-value \
  --secret-id lpms/pilot/app \
  --secret-string '{"DATABASE_URL":"postgresql://lpms_master:<new-password>@<endpoint>/lpms"}'
aws ecs update-service --cluster lpms-pilot --service lpms-pilot-app --force-new-deployment
```

---

## Formatting and Validation

```bash
# From the repo root:
terraform fmt -check -recursive terraform/

# Bootstrap root
cd terraform/bootstrap
terraform init -backend=false
terraform validate

# Pilot root (validates all 5 modules)
cd terraform/envs/pilot
terraform init -backend=false
terraform validate
```

Neither `terraform plan` nor `terraform apply` should be run by automated
tooling — they require live AWS credentials and create real resources.

---

## FLAGS Summary

| Flag | Status | Notes |
|------|--------|-------|
| FLAG 1 — Real production auth | RESOLVED | `NODE_ENV=production`, real Cognito Gate 1 |
| FLAG 2 — 2 AZs required | ACCEPTED | 2 public + 2 private subnets (free); runtime single-AZ |
| FLAG 3 — Fargate in public subnet | ACCEPTED | Saves ~$32/mo vs NAT; SG locks inbound to ALB only |
| FLAG 4 — RDS TLS app-side | RESOLVED | RDS CA bundle in image + `NODE_EXTRA_CA_CERTS` + `rds.force_ssl=1` |
| FLAG 5 — DB password in state | ACCEPTED | Mitigated by encrypted S3 backend + private ACLs |
| FLAG 6 — Cross-region inference profile ARNs | ACCEPTED | `bedrock_model_arns` var; include profile + foundation ARNs |
| FLAG 7 — Token travels over TLS | RESOLVED | ALB :443 HTTPS + :80→301 redirect; ACM cert |

**Deferred to hardening:** NAT-less hardening review, Web UI for uncertain
judge queue, quarantine sweep.

---

## machine_credential Gate — GitHub OIDC Provisioning

### Overview

`/promote` is authenticated via GitHub Actions OIDC: no long-lived shared
secret is stored. The LPMS service verifies the token's `iss`, `aud`, `exp`,
and signature against GitHub's JWKS, then asserts that an active
`machine_credential` row exists for the OIDC `repository` claim within the
target project.

**This is an application-domain action, not an infra action.** It is performed
by a human operator after the corresponding `project` + `repo` rows exist
(from onboarding), and after the GitHub Actions OIDC audience variable is
confirmed.

### Pre-requisites

1. The `project` row for the target project exists.
2. The `repo` row (`remote_url = 'https://github.com/<owner>/<repo>.git'`) is
   registered and linked to the project.
   **Important:** register the remote URL in lowercase (e.g.
   `https://github.com/crombie-dev/lpms-cloud.git`). The service normalizes
   the OIDC `repository` claim to lowercase before lookup.
3. The Fargate task's `GITHUB_OIDC_AUDIENCE` environment variable is set to
   the pilot promote endpoint URL (e.g. `https://<pilot-domain>/promote`).
4. The GitHub repo/org has the following variables configured:
   - `LPMS_PROMOTE_URL`     — full HTTPS URL of the `/promote` endpoint.
   - `LPMS_OIDC_AUDIENCE`   — same value as `GITHUB_OIDC_AUDIENCE` in the service.

### Idempotent provisioning SQL

Run the following SQL via a secure operator connection (e.g. `psql` through
AWS Systems Manager Session Manager or a bastion).  It is safe to run
multiple times (`ON CONFLICT DO NOTHING`).

```sql
-- Register a repo's CI as an OIDC promote principal for a project.
-- Replace :project_slug and :owner_repo with real values.
--
-- principal_name must equal the GitHub OIDC 'repository' claim exactly:
--   e.g. 'crombie-dev/lpms-cloud'  (no 'https://', no '.git')
--
-- token_hash uses the sentinel value 'oidc:no-shared-secret' because this
-- credential is authenticated by JWKS signature, not a stored secret.
-- A future migration MAY make this column nullable; for now the sentinel
-- documents the intent in every environment.
--
-- expires_at: set per your rotation policy; recommend 1 year from provisioning.
-- To revoke before expiry: UPDATE machine_credential SET revoked_at = now() WHERE ...

INSERT INTO machine_credential
  (project_id, principal_name, token_hash, role, expires_at)
VALUES
  (
    (SELECT id FROM project WHERE slug = :project_slug),
    :owner_repo,                    -- e.g. 'crombie-dev/lpms-cloud'
    'oidc:no-shared-secret',        -- sentinel; JWKS-authenticated, no stored secret
    'service_agent',
    now() + interval '1 year'
  )
ON CONFLICT (project_id, principal_name) DO NOTHING;
```

### Verification

After running the SQL, confirm the row exists:

```sql
SELECT id, principal_name, role, expires_at, revoked_at
FROM machine_credential
WHERE principal_name = :owner_repo;
```

To trigger a test promotion: merge a PR to the default branch of the
registered repo while the workflow `.github/workflows/promote.yml` is present.

### Revocation

```sql
UPDATE machine_credential
SET revoked_at = now()
WHERE principal_name = :owner_repo
  AND project_id = (SELECT id FROM project WHERE slug = :project_slug);
```
