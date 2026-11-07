# Proposal — terraform-infra (minimal pilot slice)

## Why
The app now has real Bedrock clients and a closed local memory loop, but no cloud
footprint. To reach a running pilot in AWS we need Infrastructure-as-Code. Goal:
the SAME Docker image running on AWS, reachable, backed by RDS Postgres 16 with
pgvector, able to call Bedrock — provisioned reproducibly via Terraform.

## Chosen approach — cheapest viable single-AZ pilot
Terraform, `us-east-1`, brand-new everything. Two layers:

1. **Backend bootstrap** (separate root, local state): versioned+encrypted S3 bucket
   (public access blocked) + DynamoDB lock table. Applied ONCE first; the main config
   then uses the S3 backend.
2. **Pilot stack** (main root, S3 backend):
   - **Network**: new VPC, **single AZ**, 1 public + 1 private subnet, IGW, route tables.
     Minimize cost — avoid NAT gateway if the architect finds a cheaper reachable pattern
     (e.g. Fargate in the public subnet with a locked security group, or minimal VPC
     endpoints). Architect to decide + FLAG.
   - **ECR**: one private repo for the app image.
   - **ECS Fargate**: cluster + 1-task service running the app image; execution role
     (ECR pull, logs, secrets read) + task role (`bedrock:InvokeModel` / Converse).
   - **ALB**: public, in front of the service. No custom domain/TLS cert yet → HTTP on
     the ALB DNS name for the pilot (HTTPS + Route53/ACM deferred to hardening).
   - **RDS**: smallest sensible — `db.t4g.micro`, single-AZ, pg16, ~20GB gp3, private
     subnet, not publicly accessible, SG allows only the Fargate SG. Deploy role has
     superuser → `CREATE EXTENSION vector` runs at migrate time.
   - **Secrets Manager**: DB credentials / `DATABASE_URL` + app config; injected into the
     task as secrets (never in the image, never committed).
   - **CloudWatch Logs**: task log group.

## Scope boundaries
IN: Terraform for the above (backend bootstrap + pilot stack), variables + example
tfvars (NO secret values committed), a short README (bootstrap → apply → migrate → push
image → run). `terraform fmt` + `terraform validate` clean.

OUT (hardening / later changes): Cognito user pool + real Gate-1 auth wiring, WAF,
API Gateway + `/promote` path, PrivateLink to Bedrock, Route53 + ACM + custom domain +
HTTPS, GitHub-OIDC deploy role + Action YAML (CI build→ECR→deploy), Multi-AZ RDS,
autoscaling, quarantine sweep job.

## OPEN DECISION for the architect to resolve/FLAG
**Prod auth vs minimal pilot.** In `NODE_ENV=production` the app FORBIDS all
`*_DEV_BYPASS` (auth, OIDC) and stubs — so authenticated MCP traffic requires a real
Cognito pool (Gate 1), which is in the hardening slice. Options to reconcile for the
pilot: (a) include a minimal Cognito user pool in this slice; (b) run the pilot task
under a non-production `NODE_ENV` (documented, time-boxed risk) so bypass is allowed;
(c) deploy infra now but keep the service scaled to 0 until Cognito lands. Architect
must pick a default + FLAG for orchestrator/user confirmation.

## Affected Areas
| Area | Files (new) | Purpose |
|------|-------------|---------|
| Backend | `terraform/bootstrap/*` | S3 state bucket + DynamoDB lock (local state) |
| Network | `terraform/modules/network/*` | VPC, subnets (1 AZ), IGW, routes, SGs |
| Compute | `terraform/modules/service/*` | ECR, ECS cluster, task def, service, ALB, roles |
| Data | `terraform/modules/data/*` | RDS pg16 + subnet group + Secrets Manager |
| Root | `terraform/envs/pilot/*` | wires modules; S3 backend; variables + example tfvars |
| Docs | `terraform/README.md` | bootstrap → apply → migrate → deploy runbook |

## Constraints
- Minimal + cheapest single-AZ; YAGNI (no Multi-AZ, no NAT unless unavoidable, no
  autoscaling, no extra AZs).
- NO secrets, `.tfvars` with real values, or `.tfstate` committed (add to `.gitignore`).
- `terraform apply` is HUMAN/CI out-of-band (needs AWS creds); this change delivers
  validated, fmt-clean code + a runbook, not a live apply.
- Reuse the existing app Dockerfile (from dev-harness); do not rewrite the app.
