# 02 · Hosting, infra y seguridad (AWS)

## Regla madre
"100% seguro" no existe; se gestiona riesgo con **defensa en profundidad + menor privilegio +
mínima superficie propia**. Correr la menor cantidad de cosas propias posible (servicios administrados).

## Por qué NO todo en una EC2
Un solo servidor con OAuth + DB + endpoints = **un único radio de explosión** y sin menor privilegio
(todo comparte namespace de red y rol IAM). La EC2 sirve **solo para el piloto**; producción va a la
topología administrada de abajo.

## Topología (VPC, 3 capas de red)
- **Subnets públicas:** solo ALB + WAF (o el borde de AgentCore). Nada más público.
- **Subnets privadas (app):** compute en Fargate, sin IP pública, alcanzable solo por el borde.
- **Subnets aisladas (datos):** RDS PostgreSQL Multi-AZ, cifrada con KMS, sin ruta a internet.
- **VPC Endpoints (PrivateLink)** para Bedrock/Secrets/S3/ECR → el tráfico no toca internet.

## Borde: ALB vs API Gateway vs AgentCore (decidido)
- **API Gateway HTTP API (v2):** timeout duro de 30 s **NO ampliable** y **no soporta streaming/SSE** →
  descartado para el endpoint MCP (que usa SSE largo).
- **API Gateway REST (v1):** sí agregó streaming SSE (hasta 15 min), pero para llegar a compute privado
  igual necesitás VPC Link a un ALB/NLB → agregás una capa con cap encima del balanceador que igual necesitás.
- **ALB:** SSE nativo, idle timeout configurable (~4000 s). Es el fit para MCP.
- **AgentCore Gateway (Bedrock):** OAuth Resource Server que sigue la spec de auth de MCP (valida JWT de
  Cognito, discovery, WWW-Authenticate). Te ahorra la plomería de borde+auth+transporte. NO reemplaza la
  lógica de negocio ni el RBAC fino (eso vive en tu backend). Contras: lock-in, servicio nuevo; a verificar:
  streaming SSE largo y precio.

## Topología elegida (target)
- **Cognito** — 1 pool federado a Google Workspace; varios app clients + scopes.
- **AgentCore** — todo lo del MCP server (puerta + inbound auth); targets = tu backend (Fargate) → RDS.
- **API Gateway** — el resto: API web (Cognito JWT authorizer) y `/promote` de las Actions (IAM authorizer, OIDC).
- **Fargate** — backend (tools, API, promoción, juez). **RDS** privado. **Bedrock** = LLM del juez, in-region.
- **Costuras a clavar:** (1) `/promote` NO va por Cognito → IAM/OIDC; (2) el RBAC fino tiene que ser
  **una sola lib** que usen ambos backends (no dos puertas con distinta cerradura); (3) los targets de
  AgentCore corren en TU VPC para llegar a RDS.

## Cómo se conectan los clientes
Todos le pegan al **borde (ALB/AgentCore)**, nunca a la caja. Se publica **una URL** (ej.
`https://mcp.crombie.dev/mcp`); el compute vive privado detrás. Route 53 → borde; ACM (TLS 443); WAF.
SG: borde acepta 443 del mundo; compute solo acepta del borde; RDS solo del compute. Server **stateless**
(estado en RDS) → sin sticky sessions. Gotcha OAuth: permitir el **callback loopback** del cliente CLI en Cognito.

## Deploy del MCP server (CI/CD)
OJO: dos pipelines distintos. **(a) Deploy de la plataforma** (este) vs **(b) pipeline de memoria** (corre en
los repos de los devs al mergear). Para (a): Dockerfile → GitHub Actions (OIDC, sin keys) build → **push a ECR** →
deploy (piloto EC2 vía SSM/CodeDeploy; prod = update del servicio ECS/Fargate, rolling + rollback). Misma imagen,
distinto target: el swap EC2→Fargate es transparente.

## Lista de servicios AWS
Identidad: **Cognito, IAM**. Compute/MCP: **Bedrock AgentCore, ECS+Fargate, EC2 (piloto), Lambda (opt)**.
Contenedores: **ECR** (+ CodeBuild/Pipeline/Deploy opt). Borde: **API Gateway, ALB, WAF, CloudFront,
Route 53, ACM**. Datos: **RDS PostgreSQL (+pgvector ext), S3**. IA: **Bedrock**. Seguridad: **Secrets
Manager, KMS, GuardDuty (opt), Security Hub (opt)**. Red: **VPC, VPC Endpoints, NAT GW, Internet GW**.
Observabilidad: **CloudWatch, CloudTrail, AgentCore Observability**.
Piloto mínimo: EC2, ECR, RDS, Cognito, IAM, Route 53, ACM, Secrets Manager, KMS, VPC, CloudWatch.
