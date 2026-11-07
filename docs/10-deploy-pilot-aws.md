# 10 — Deploy del Pilot en AWS (runbook ejecutado)

Registro del primer deploy end-to-end del pilot LPMS a AWS, desde una cuenta
vacía hasta un MCP server autenticado, con TLS y verificado. Complementa el
runbook de referencia en `terraform/README.md` con lo que **efectivamente se
ejecutó**, los valores reales y las decisiones tomadas.

- **Cuenta AWS:** `<AWS_ACCOUNT_ID>` · **Región:** `us-east-1`
- **Dominio:** `https://<DOMAIN>/mcp` (hosted zone existente `<DOMAIN>`, zone id `<HOSTED_ZONE_ID>`)
- **Repo/proyecto:** `<GITHUB_ORG>/<REPO>` → proyecto `<REPO>`
- **Costo estimado:** ~$46/mes (ALB + Fargate + RDS t4g.micro + IPv4 + Secrets + Route53)

---

## 1. Backend de estado (bootstrap)

Root `terraform/bootstrap/` (state local, sin backend — resuelve el
huevo-y-la-gallina). Creó:

- Bucket S3 `<TFSTATE_BUCKET>` — versioning, KMS, public-access-block, policy TLS-only.
- Tabla DynamoDB `<TFLOCK_TABLE>` — lock de state, `deletion_protection_enabled = true`.

```powershell
cd terraform/bootstrap
terraform init
terraform apply -var='state_bucket_name=<TFSTATE_BUCKET>' -var='lock_table_name=<TFLOCK_TABLE>'
```

> El `terraform.tfstate` de este root es **local y se conserva** (no se migra a S3).

---

## 2. Audit de seguridad pre-deploy y hardening

Antes del primer `apply` se corrió un audit (crombie-security + crombie-reviewer)
sobre todo el IaC. El perímetro de entrada quedó limpio (sin `0.0.0.0/0` de
ingress, SGs en cadena ALB→Fargate→RDS, Cognito Gate1+Gate2, TLS forzado). Se
aplicaron **4 fixes de durabilidad/destrucción antes del apply**:

| # | Archivo | Cambio |
|---|---------|--------|
| 1 | `modules/data/main.tf` | RDS: `deletion_protection=true`, `skip_final_snapshot=false`, `final_snapshot_identifier="lpms-pilot-final"`, `backup_retention_period=7` |
| 2 | `modules/data/main.tf` | Secrets Manager: `recovery_window_in_days` 0 → 7 |
| 3 | `bootstrap/main.tf` | DynamoDB: `deletion_protection_enabled=true` |
| 4 | `modules/service/main.tf` | Eliminado el registro Route53 AAAA (VPC es IPv4-only; el AAAA a un ALB IPv4 es inválido) |

Backlog de hardening pendiente (no bloqueante con la IP cerrada): MFA `ON`,
access logs del ALB, WAF (antes de ampliar el ingress), ECR `IMMUTABLE`, KMS en
CloudWatch Logs, alarmas, y scopear el `audience` de OIDC.

---

## 3. Infra del pilot

Root `terraform/envs/pilot/` (backend S3). `backend.hcl` apunta a
`<TFSTATE_BUCKET>`, key `envs/pilot/terraform.tfstate`, lock
`<TFLOCK_TABLE>`.

Variables reales en `pilot.tfvars` (gitignoreado):
- `alb_ingress_cidrs = ["<OPERATOR_IP>/32"]` — cerrado a la IP del operador.
- `route53_zone_name` / `domain_name = "<DOMAIN>"`, `create_hosted_zone = false`.
- `authorized_user_emails` = <ADMIN_EMAIL> y los de otros colaboradores autorizados.
- `bedrock_model_arns` incluye el inference-profile de la cuenta (evita AccessDenied silencioso del judge).
- `desired_count` = 0 en el primer apply → **1 tras verificar healthy** (ver §7).

```powershell
cd terraform/envs/pilot
terraform init -backend-config="backend.hcl"
terraform apply -var-file=pilot.tfvars      # 43 recursos
```

Outputs clave: ver `terraform output` (ECR url, cluster, cognito pool/client, pilot_url).

> **Delegación DNS:** con `create_hosted_zone=false`, la zona debe estar delegada
> desde `<COMPANY_DOMAIN>`. Verificado con `nslookup -type=NS <DOMAIN>`
> (devuelve NS de AWS) → ACM validó sin colgarse.

---

## 4. Imagen Docker → ECR

```powershell
$pw = aws ecr get-login-password --region us-east-1
docker login --username AWS --password $pw <AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com
docker build -t lpms-pilot-app .
docker tag lpms-pilot-app:latest "<AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/lpms-pilot-app:latest"
docker push "<AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/lpms-pilot-app:latest"
```

> En PowerShell, piping del token a `docker login --password-stdin` corrompe el
> stdin (encoding) → usar variable + `--password`.

---

## 5. Migraciones (Step 7)

Tarea ECS efímera (`run-task`) que corre `node dist/db/migrate.js` — **solo
migrate, nunca seed**. Crea tablas + extensión `pgvector`. Overrides en
`migrate-overrides.json` (gitignoreado). Exit code `0` = OK.

RDS es privada: no hay acceso `psql` desde afuera. Todo lo que necesita tocar la
base se corre como tarea ECS (que sí está en el SG de Fargate).

---

## 6. Gate-2 — provisioning de usuarios (Step 9)

Se creó `src/db/provision.ts` (script idempotente, parametrizado por env var
`PROVISION_JSON`, transaccional, `ON CONFLICT DO NOTHING`, queries
parametrizadas). Añadido a `package.json` como script `provision`.

Inserta, en orden de dependencia: `repo` (remote_url, normalizado a minúsculas)
→ `project` (slug) → `app_user` (idp_subject = Cognito sub) → `project_membership`.

Schema real (fuente: migraciones): tabla `repo` (singular), IDs vía
`gen_random_uuid()` DB-side (los ULID son solo para `staging_session`).

Ejecutado como tarea ECS con `command = node dist/db/provision.js` y
`provision-overrides.json` (gitignoreado, contiene los Cognito subs). Exit `0`.

Passwords de Cognito seteadas out-of-band con `admin-set-user-password`
(los usuarios se crean en `FORCE_CHANGE_PASSWORD`, sin password en Terraform).

---

## 7. Arranque y verificación

```powershell
# Prender el servicio
terraform apply -var-file=pilot.tfvars -var="desired_count=1"

# Target health → "healthy"
aws elbv2 describe-target-health --target-group-arn (aws elbv2 describe-target-groups --names lpms-pilot-tg --region us-east-1 --query "TargetGroups[0].TargetGroupArn" --output text) --region us-east-1 --query "TargetHealthDescriptions[].TargetHealth.State"
```

Prueba E2E (Gate1 + Gate2 + MCP):

```powershell
# Token Cognito
$TOKEN_JSON = aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH --client-id <client-id> --auth-parameters "USERNAME=...,PASSWORD=..." --region us-east-1 | ConvertFrom-Json
$ACCESS_TOKEN = $TOKEN_JSON.AuthenticationResult.AccessToken

# Llamada MCP (Accept debe incluir application/json Y text/event-stream)
curl.exe -s -X POST https://<DOMAIN>/mcp `
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" `
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "X-Git-Remote: https://github.com/<GITHUB_ORG>/<REPO>.git" `
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"recall\",\"arguments\":{\"query\":\"test\"}}}'
```

Resultado esperado (base recién provisionada):
`{"results":[],"total_matches":0,"cursor":null}` → pilot operativo.

> **Gotcha `desired_count`:** el servicio se prendió con `-var="desired_count=1"`.
> Se fijó `desired_count = 1` en `pilot.tfvars` para que un `apply` sin ese flag
> no apague el servicio.

---

## 8. CI/CD — pipeline de deploy de app (OIDC)

Root `terraform/cicd/` + `.github/workflows/deploy.yml`. Automatiza SOLO deploy
de **código de app** (build → push → roll del servicio); la infra sigue siendo
`apply` manual (rol de altísimo privilegio, cambios infrecuentes).

- OIDC provider de GitHub Actions + rol `lpms-pilot-ci-deploy`.
- Trust scopeado a `repo:<GITHUB_ORG>/<REPO>:ref:refs/heads/main` (solo main, sin wildcard).
- Permisos mínimos: ECR push al repo + ECS register/update del servicio +
  `iam:PassRole` scopeado exacto a los 2 roles (execution + task). Sin ec2/rds/iam-create.
- Sin AWS keys almacenadas (OIDC puro). Solo una repo variable `AWS_CICD_ROLE_ARN`.
- Deploy: tags por `:<git-sha>` (inmutable) + `:latest`, registra nueva task-def
  revision, `update-service`, `wait services-stable`. Sin smoke test al ALB (IP-locked).

El workflow asume el rol vía la repo variable `AWS_ROLE_ARN`.

### Estado real del rol OIDC — RIESGO ACEPTADO ⚠️

En la práctica el pipeline usa el rol **`<OIDC_ROLE_NAME>`** (no el
`lpms-pilot-ci-deploy` del diseño). La **trust policy está bien acotada**
(`repo:<GITHUB_ORG>/<REPO>:ref:refs/heads/main`, sin managed policies), PERO su
policy inline es amplia (un rol de `terraform apply` completo): `ecs:*`,
`lambda:*`, `rds:*`, `ec2:*`, `elasticloadbalancing:*`, `logs/cloudwatch:*`,
acceso al state S3, e IAM `CreateRole`/`PutRolePolicy` + `iam:PassRole` con
`Resource: "*"`.

**Riesgo (aceptado explícitamente por el owner):** la combinación
`iam:CreateRole` + `iam:PutRolePolicy` + `iam:PassRole:*` es una vía de
**escalada de privilegios**. Si el CI de `main` se compromete, el radio de
explosión es la cuenta AWS completa. Se decidió dejar el rol como está.

**Mitigaciones sugeridas (pendientes, no aplicadas):** acotar `iam:PassRole` a
ARNs específicos, quitar/gatear `iam:CreateRole`/`PutRolePolicy` con permission
boundary, y/o agregar un GitHub Environment con required reviewers como approval
gate antes de cada deploy.

---

## 9. Pendientes

- [ ] Activar la pipeline CI/CD (`terraform apply` en `terraform/cicd/` + repo var).
- [ ] Que un colaborador pruebe su flujo de token + endpoint.
- [ ] Backlog de hardening (§2) antes de abrir la IP o ir a prod.
- [ ] Observabilidad: alarmas CloudWatch (task caída, RDS, Bedrock, 429).

---

## Day-2 (referencia rápida)

- **Nuevo deploy manual:** `docker build/push` + `aws ecs update-service --cluster lpms-pilot --service lpms-pilot-app --force-new-deployment`
- **Pausar (costo 0):** `terraform apply -var-file=pilot.tfvars -var="desired_count=0"`
- **Logs:** `aws logs tail /lpms/pilot/app --follow`
- **Nuevo usuario/repo:** volver a correr la tarea ECS de `provision` con un `PROVISION_JSON` actualizado (es idempotente).
