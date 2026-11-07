# Archive Report — terraform-infra

## Outcome: DONE (verify PASS after remediation)

Delivered Infrastructure-as-Code for a cheapest-viable single-AZ AWS pilot that runs
the SAME app image on Fargate with REAL Cognito auth (Gate 1) and HTTPS end-to-end.
31 files; `terraform fmt` + `validate` clean on both roots.

## Delivered
- **Roots**: `terraform/bootstrap/` (local state → versioned/encrypted/public-blocked
  S3 state bucket + HTTPS-only policy + DynamoDB lock, `prevent_destroy`) and
  `terraform/envs/pilot/` (partial S3 backend + committed `backend.hcl`).
- **Modules**: `network` (VPC, 2 public + 2 private subnets/2 AZs, IGW, SGs, NO NAT),
  `data` (RDS db.t4g.micro pg16 gp3 encrypted private + `rds.force_ssl=1` + random
  password→DATABASE_URL→Secrets Manager), `cognito` (admin-only pool, public app
  client, USER_PASSWORD_AUTH, 15-min TTL, MFA OPTIONAL+TOTP, authorized emails
  for_each, no passwords in state), `dns-tls` (ACM cert us-east-1 DNS-validated +
  Route53 ALIAS→ALB), `service` (ECR, ECS cluster/task/service, ALB :443 HTTPS +
  :80→301 redirect, least-privilege Bedrock task role, prod env block).
- **App**: `Dockerfile` bakes the RDS CA bundle (integrity-guarded) for
  `NODE_EXTRA_CA_CERTS`; no other app change.
- **Docs**: `terraform/README.md` runbook; `.gitignore` TF ignores; project-map infra
  topology.

## Verify
FAIL → remediated (2 HIGH operational + 6 MEDIUM + 2 LOW) → PASS. Security core clean
(no CRITICAL/HIGH): IAM least-privilege, SG isolation, TLS 1.3 e2e, secrets, encryption.

## Apply-time operator inputs (out-of-band; NOT in repo)
- Real `domain_name` + `route53_zone_name` (+ `create_hosted_zone` if no zone yet);
  `alb_ingress_cidrs` (no default — allowlist); `bedrock_model_arns` MUST include the
  cross-region **inference-profile ARN** (not just foundation-model ARNs) or the judge
  gets AccessDenied → uncertain.
- Runbook: bootstrap → init pilot → apply (desired_count=0) → push image → run-task
  migrate (NOT seed) → admin-set-user-password [+ MFA] → manual Gate-2 SQL (project +
  app_user + project_membership) → desired_count=1 → initiate-auth token →
  `https://<domain>/mcp`.

## Deferred to hardening backlog (accepted pilot posture)
ECR IMMUTABLE + git-SHA tags; RDS `deletion_protection`/`skip_final_snapshot=false`/
Secrets `recovery_window>=7`; execution role ECR-scoped inline policy; CloudWatch CMK;
ALB access logs + WAF/rate-limit; ECS `deployment_configuration`; real GitHub-OIDC
`/promote` (currently fail-closed); Multi-AZ; NAT/PrivateLink review.
