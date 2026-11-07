# Terraform CI/CD Root — GitHub Actions Deploy Role

Creates the **minimal, least-privilege** AWS identity that lets GitHub Actions
auto-deploy **app code changes** to the already-live pilot: build → push to ECR
→ register a new ECS task-def revision → roll the service.

**Infra apply is OUT OF SCOPE.** This role cannot run `terraform apply` or
create/modify IAM, VPC/EC2, RDS, Route53, or Secrets Manager. Infra changes stay
manual (see `../README.md`).

---

## What this root creates

| Resource | Purpose |
|----------|---------|
| `aws_iam_openid_connect_provider.github` | Trusts `token.actions.githubusercontent.com` (assumes it does not yet exist). Thumbprint fetched dynamically via the `tls` provider — never hardcoded. |
| `aws_iam_role.ci_deploy` (`lpms-pilot-ci-deploy`) | Trust policy scoped to `aud = sts.amazonaws.com` and `sub = repo:<GITHUB_ORG>/<REPO>:ref:refs/heads/main` — **only `main` of the trusted repo**. 1h max session. |
| Inline deploy policy | ECR auth + push to `lpms-pilot-app`, `ecs:RegisterTaskDefinition`/`DescribeTaskDefinition`, `ecs:UpdateService`/`DescribeServices`/`DescribeTasks` on the `lpms-pilot` cluster/service, and `iam:PassRole` scoped to exactly the two existing ECS roles. |

State lives in the **existing** S3 backend (`<TFSTATE_BUCKET>`) under a
distinct key `cicd/terraform.tfstate`, so it never collides with the pilot infra
state.

---

## Step 1 — One-time bootstrap (manual, human-run)

The S3 bucket + DynamoDB lock table already exist (from `terraform/bootstrap/`).
No new backend bootstrap is needed — just init against a new key and apply.

```bash
cd terraform/cicd

terraform init -backend-config=backend.hcl
terraform validate

# Review the plan — expect exactly: 1 OIDC provider, 1 role, 1 inline policy,
# 1 guard (terraform_data). No infra resources.
terraform plan

terraform apply

# Grab the role ARN for the GitHub repo variable:
terraform output -raw ci_deploy_role_arn
```

`account_id` and `github_repo` have no defaults: pass them via `-var` (account `<AWS_ACCOUNT_ID>`,
repo `<GITHUB_ORG>/<REPO>`). The other defaults (`us-east-1`, branch `main`) can be
overridden via `-var` as needed.

> If the account already has a GitHub OIDC provider for
> `token.actions.githubusercontent.com`, this apply will fail on a duplicate.
> In that case remove the `aws_iam_openid_connect_provider` resource from
> `main.tf` and `import` the existing one, or reference it via a data source.

---

## Step 2 — Set the GitHub repo variable (no secrets)

OIDC needs **no stored AWS keys**. Set one **non-secret** repository variable on
`<GITHUB_ORG>/<REPO>`:

| Variable | Value |
|----------|-------|
| `AWS_CICD_ROLE_ARN` | the `ci_deploy_role_arn` output from Step 1 |

```bash
# via gh CLI (repo Settings → Secrets and variables → Actions → Variables):
gh variable set AWS_CICD_ROLE_ARN \
  --repo <GITHUB_ORG>/<REPO> \
  --body "$(terraform output -raw ci_deploy_role_arn)"
```

No `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are created or stored anywhere.

---

## Step 3 — Test the pipeline (`workflow_dispatch`)

`.github/workflows/deploy.yml` supports manual dispatch so you can validate the
role and flow without a code push:

```bash
gh workflow run "Deploy App" --repo <GITHUB_ORG>/<REPO> --ref main
gh run watch --repo <GITHUB_ORG>/<REPO>
```

Expected: OIDC assume-role succeeds → image pushed as `:<sha>` + `:latest` → new
task-def revision registered → `update-service` → `wait services-stable`
returns 0. There is **no** post-deploy HTTP check (ALB ingress is IP-locked);
stability is the success gate.

To confirm the running task is pinned to the immutable sha tag:

```bash
aws ecs describe-services --cluster lpms-pilot --services lpms-pilot-app \
  --query 'services[0].taskDefinition'
aws ecs describe-task-definition --task-definition <that-arn> \
  --query 'taskDefinition.containerDefinitions[0].image'   # → …:<git-sha>
```

---

## Least-privilege summary (every grant justified)

| Statement | Actions | Resource | Why not tighter |
|-----------|---------|----------|-----------------|
| `EcrAuth` | `ecr:GetAuthorizationToken` | `*` | AWS API does not support resource-level perms; grants no data access alone. |
| `EcrPushToPilotRepo` | layer upload + `PutImage` + read-back | `repository/lpms-pilot-app` | Single repo ARN. |
| `EcsTaskDefinition` | `RegisterTaskDefinition`, `DescribeTaskDefinition` | `*` | AWS API does not support resource-level perms for these. |
| `EcsUpdateAndDescribeService` | `UpdateService`, `DescribeServices` | exact service ARN | — |
| `EcsDescribeTasks` | `DescribeTasks` | `task/lpms-pilot/*` + `ecs:cluster` condition | Task ARNs are ephemeral; scoped to the pilot cluster. |
| `PassEcsRolesOnly` | `iam:PassRole` | exactly the 2 ECS role ARNs + `iam:PassedToService=ecs-tasks.amazonaws.com` | Required by RegisterTaskDefinition. See residual risk. |

**No** `ec2:*`, `rds:*`, `route53:*`, `secretsmanager:*`, `iam:Create*`, or
`iam:Put*` — the role cannot alter infra or escalate.

---

## Residual risk — `iam:PassRole`

`iam:PassRole` on the execution + task roles is the highest-privilege grant.
`RegisterTaskDefinition` requires it because a task def references both roles.
Bounded by:

- Scoped to **exactly** those two role ARNs (no wildcard) and gated by
  `iam:PassedToService = ecs-tasks.amazonaws.com` (cannot be passed elsewhere).
- The pipeline can only pass roles that **already** define their own least
  privilege (execution: ECR pull + Logs + one secret; task: Bedrock on model
  ARNs). It cannot widen them — it has no `iam:PutRolePolicy`/`AttachRolePolicy`.
- Trust is limited to `main` of `<GITHUB_ORG>/<REPO>` via the OIDC `sub`, so only
  merged/dispatched runs on that branch can assume the role at all.

Practical worst case if the trusted repo's `main` CI is compromised: an attacker
could register a task def running an arbitrary image under the existing task
role (Bedrock-on-specified-models) and roll the pilot service. They **cannot**
reach RDS/Secrets/IAM/networking through this role. Mitigate further later with
GitHub environment protection / required reviewers on deploys if warranted (not
added now — YAGNI).

---

## Validation (no apply)

```bash
cd terraform/cicd
terraform fmt -check
terraform init -backend=false
terraform validate
```

> Action pins in `deploy.yml` are full commit SHAs with version comments.
> Verify/refresh them against the upstream release tags when bumping versions.
