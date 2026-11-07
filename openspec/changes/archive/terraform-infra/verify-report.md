# Verify Report — terraform-infra

## Verdict: PASS (post-remediation)

- Pre-remediation: FAIL — static review surfaced 2 HIGH (operational); security core CLEAN.
- Remediation batch closed all 10 findings (H1, H2, M1–M6, L1, L2).
- Re-gate: `terraform fmt -check -recursive` clean; `terraform init -backend=false &&
  terraform validate` PASS on both roots (aws 5.100.0, random 3.9.0).
- **Verdict flips to PASS**: both HIGH closed, gate green. Deferred-hardening items
  (below) documented in backlog for the prod-promotion pass.

Gate (original apply): `terraform fmt -check -recursive` clean; `terraform validate`
PASS on both roots. Static review + security audit surfaced 2 HIGH (operational).
Security core = CLEAN (no CRITICAL/HIGH): IAM least-privilege, SGs, TLS 1.3 e2e,
secrets, encryption all sound.

## Findings

### HIGH (fix now)
- **H1 (review) — example `bedrock_model_arns` omits the inference-profile ARN.**
  `pilot.tfvars.example` lists only foundation-model ARNs, but `bedrock_model_id`
  is a cross-region profile (`us.anthropic…`). IAM evaluates the PROFILE ARN → judge
  `Converse` gets `AccessDenied` → `uncertain` → auto-promotion silently disabled.
  Fix: add the inference-profile ARN (commented, account-specific) as the first
  example entry + a note.
- **H2 (review) — `desired_count = 1` default before the image exists in ECR.**
  `apply` (step 5) precedes image push (step 6) → `CannotPullContainerError` retry
  loop. Fix: example default `desired_count = 0`; README step 5 note; step 10 bumps to 1.

### MEDIUM (fix in this batch)
- **M1 (review) — bootstrap DynamoDB lock table lacks `lifecycle{prevent_destroy}`**
  (S3 bucket has it). Add it.
- **M2 (review+security) — `bedrock_model_arns` no validation.** Add a `validation`
  block (both `service/variables.tf` + root): `length > 0` AND every element matches
  `^arn:aws:bedrock:` (blocks empty list AND a `["*"]` footgun → account-wide Bedrock).
- **M3 (review) — missing root outputs for the runbook.** Add `public_subnet_ids`,
  `fargate_sg_id` (run-task migrate cmd) + `ecs_service_name` (Day-2 ops).
- **M4 (review) — Gate-2 SQL missing `INSERT INTO project`.** `project_membership`
  FK-fails without it. Add a concrete `INSERT INTO project` example.
- **M5 (review+security L5) — Dockerfile CA bundle fetched with no integrity check.**
  Add a non-empty + PEM-header guard and a commented `sha256sum -c` pin (operator
  fills the out-of-band hash; note CA-rotation caveat).
- **M6 (security) — Cognito MFA OFF on an internet-facing prod pool.** Set
  `mfa_configuration = "OPTIONAL"` + `software_token_mfa_configuration{enabled=true}`
  (TOTP; no SES/cost). Runbook: `admin-set-user-mfa-preference` per user.

### LOW (fix cheap ones now)
- **L1 (security) — `pilot.tfvars.example` uses real domain `crombie.dev`** (REQ-08
  says no real domains). Replace with `example.com` / RFC-2606 safe values.
- **L2 (security) — S3 state bucket has no HTTPS-only policy** (state holds the DB
  password). Add `aws_s3_bucket_policy` denying `aws:SecureTransport=false`.

### Deferred to hardening backlog (acknowledged pilot posture — NOT fixed now)
- ECR `image_tag_mutability=IMMUTABLE` (pilot uses `:latest`).
- RDS `deletion_protection=true` + `skip_final_snapshot=false` + Secrets Manager
  `recovery_window_in_days>=7`.
- Execution role: replace managed `AmazonECSTaskExecutionRolePolicy` with ECR-scoped
  inline policy.
- CloudWatch Logs CMK; ALB access logs + WAF/rate-limit; ECS `deployment_configuration`.

## Clean (no action)
No CRITICAL/HIGH security. Module wiring one-directional, NO ALB↔cert cycle
(`certificate_arn` from `aws_acm_certificate_validation`). Prod-env vars complete +
exact. Secrets hygiene solid. Lock files committed. Runbook order matches REQ-10.

## Remediation plan
Single worker, one batch: H1, H2, M1–M6, L1, L2 + document the deferred items in
backlog. Re-gate (`fmt`/`validate`). Verdict flips to PASS when both HIGH are closed
and the gate stays green.
