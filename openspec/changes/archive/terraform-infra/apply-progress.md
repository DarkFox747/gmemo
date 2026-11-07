# Apply Progress — terraform-infra

## Batch 1 — SUCCESS (single worker, T001–T012)

Delivered the full Terraform for the single-AZ pilot + real Cognito (Gate 1) + HTTPS
(Route53 + ACM). 31 files.

Roots: `terraform/bootstrap/` (local state → S3 bucket + DynamoDB lock),
`terraform/envs/pilot/` (partial S3 backend + committed `backend.hcl`).
Modules: `network`, `data`, `cognito`, `dns-tls`, `service`.
Also: `Dockerfile` (RDS CA bundle line), `.gitignore` (TF ignores; keeps
`*.tfvars.example`/`backend.hcl`/`.terraform.lock.hcl`), `terraform/README.md`
(runbook), `openspec/project-map.yaml` (infra topology).

Gate: `terraform fmt -check -recursive` clean (1 auto-fix applied to
service/main.tf); `terraform init -backend=false && terraform validate` PASS on BOTH
roots (providers `hashicorp/aws v5.100.0`, `hashicorp/random v3.9.0`; lock files
committed). `plan`/`apply` NOT run (need AWS creds — human/CI, out-of-band).

Deviations from design: none. Open apply-time inputs (not blocking code): real
`domain_name`/`route53_zone_name` (example tfvars use fake values); `alb_ingress_cidrs`
kept as required allowlist (no default) per recommendation.

Issues: none.

## Batch 2 — remediation (verify findings) — SUCCESS

Findings closed: H1, H2, M1–M6, L1, L2.
- H1 example `bedrock_model_arns` inference-profile ARN added
- H2 `desired_count` default → 0 + README gates
- M1 DynamoDB lock `prevent_destroy`
- M2 `bedrock_model_arns` validation (len>0 + `^arn:aws:bedrock:`) both roots
- M3 root outputs `public_subnet_ids` / `fargate_sg_id` / `ecs_service_name`
- M4 Gate-2 SQL `INSERT INTO project` before `project_membership`
- M5 Dockerfile RDS CA integrity guard (non-empty + PEM header + commented sha256 pin)
- M6 Cognito MFA OPTIONAL + TOTP + runbook note
- L1 example tfvars → RFC-2606 safe values (example.com)
- L2 S3 state bucket HTTPS-only Deny policy

Files: `pilot.tfvars.example`, `envs/pilot/variables.tf`, `modules/service/variables.tf`,
`bootstrap/main.tf`, `envs/pilot/outputs.tf`, `modules/cognito/main.tf`, `Dockerfile`,
`terraform/README.md`. Re-gate: `fmt`/`validate` PASS both roots. Verify → PASS.

Deferred to hardening backlog (intentional pilot posture): ECR IMMUTABLE, RDS
deletion_protection/final-snapshot/recovery-window, execution-role ECR scoping,
CloudWatch CMK, ALB access logs + WAF/rate-limit, ECS deployment_configuration.
