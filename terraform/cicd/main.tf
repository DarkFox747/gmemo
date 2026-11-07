# ===========================================================================
# CI/CD deploy role for GitHub Actions — APP CODE deploys ONLY.
#
# Scope: build + push the Docker image to the existing ECR repo, register a new
# ECS task definition revision pinned to the immutable :<git-sha> tag, roll the
# ECS service, and wait for it to stabilise.
#
# EXPLICITLY OUT OF SCOPE (this role CANNOT): run terraform apply, create/modify
# IAM, EC2/VPC, RDS, Route53, Secrets Manager, or any networking. No wildcards on
# any resource where a concrete ARN exists.
# ===========================================================================

data "aws_caller_identity" "current" {}

locals {
  ecr_repository_arn = "arn:aws:ecr:${var.aws_region}:${var.account_id}:repository/${var.ecr_repository_name}"
  ecs_service_arn    = "arn:aws:ecs:${var.aws_region}:${var.account_id}:service/${var.ecs_cluster_name}/${var.ecs_service_name}"
  ecs_cluster_arn    = "arn:aws:ecs:${var.aws_region}:${var.account_id}:cluster/${var.ecs_cluster_name}"
  ecs_tasks_arn      = "arn:aws:ecs:${var.aws_region}:${var.account_id}:task/${var.ecs_cluster_name}/*"

  execution_role_arn = "arn:aws:iam::${var.account_id}:role/${var.execution_role_name}"
  task_role_arn      = "arn:aws:iam::${var.account_id}:role/${var.task_role_name}"

  github_oidc_url = "https://token.actions.githubusercontent.com"
  github_oidc_sub = "repo:${var.github_repo}:ref:refs/heads/${var.github_branch}"
}

# Guard: fail fast if applied into the wrong account (ARNs above are built from
# var.account_id; this asserts the caller matches so we never scope the policy
# to a foreign account's resources).
resource "terraform_data" "account_guard" {
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.account_id
      error_message = "Caller account (${data.aws_caller_identity.current.account_id}) does not match var.account_id (${var.account_id}). Aborting to avoid mis-scoped ARNs."
    }
  }
}

# ---------------------------------------------------------------------------
# GitHub Actions OIDC provider (one per account). Assumes it does NOT already
# exist. Thumbprint is fetched dynamically from GitHub's TLS chain so it never
# goes stale. AWS validates GitHub tokens against its own trust store, but the
# resource still requires a thumbprint value.
# ---------------------------------------------------------------------------
data "tls_certificate" "github_oidc" {
  url = local.github_oidc_url
}

resource "aws_iam_openid_connect_provider" "github" {
  url             = local.github_oidc_url
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github_oidc.certificates[0].sha1_fingerprint]

  tags = {
    Name = "github-actions-oidc"
  }
}

# ---------------------------------------------------------------------------
# Trust policy — TIGHTLY scoped:
#   - only tokens from token.actions.githubusercontent.com
#   - aud must be sts.amazonaws.com (StringEquals)
#   - sub must be EXACTLY repo:<repo>:ref:refs/heads/<branch> (StringEquals, not
#     wildcard) — so ONLY main of the trusted repo can assume this role. Tags,
#     PRs, and other branches are rejected.
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "assume_role" {
  statement {
    sid     = "GitHubActionsOIDC"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.github_oidc_sub]
    }
  }
}

resource "aws_iam_role" "ci_deploy" {
  name                 = var.role_name
  assume_role_policy   = data.aws_iam_policy_document.assume_role.json
  max_session_duration = 3600 # 1h — deploys are short; minimise credential lifetime.

  tags = {
    Name = var.role_name
  }
}

# ---------------------------------------------------------------------------
# Least-privilege deploy policy. Each statement is justified inline. Resources
# are concrete ARNs except where the AWS API does NOT support resource-level
# permissions (ecr:GetAuthorizationToken, ecs:RegisterTaskDefinition,
# ecs:DescribeTaskDefinition) — those are documented as required "*".
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "ci_deploy" {
  # ECR: obtain a login token. This action does NOT support resource-level
  # permissions (AWS requires "*") — it grants no data access on its own.
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # ECR: push (and read-back) layers + images, scoped to the single repo.
  statement {
    sid    = "EcrPushToPilotRepo"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [local.ecr_repository_arn]
  }

  # ECS: register a new task definition revision and read task defs to base the
  # new revision on. Neither action supports resource-level permissions — AWS
  # requires "*". They only create/read task-def revisions; no service or infra
  # mutation is possible with these alone.
  statement {
    sid    = "EcsTaskDefinition"
    effect = "Allow"
    actions = [
      "ecs:RegisterTaskDefinition",
      "ecs:DescribeTaskDefinition",
    ]
    resources = ["*"]
  }

  # ECS: roll the service to the new task-def revision + read its status, scoped
  # to the exact service ARN.
  statement {
    sid    = "EcsUpdateAndDescribeService"
    effect = "Allow"
    actions = [
      "ecs:UpdateService",
      "ecs:DescribeServices",
    ]
    resources = [local.ecs_service_arn]
  }

  # ECS: describe tasks (used while waiting for stability), scoped to tasks in
  # the pilot cluster only, and additionally guarded by the cluster condition.
  statement {
    sid       = "EcsDescribeTasks"
    effect    = "Allow"
    actions   = ["ecs:DescribeTasks"]
    resources = [local.ecs_tasks_arn]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [local.ecs_cluster_arn]
    }
  }

  # iam:PassRole — scoped to EXACTLY the two existing ECS roles, and only when
  # passed to the ECS tasks service. Required by RegisterTaskDefinition because
  # the task def references execution_role_arn + task_role_arn. This is the
  # highest-privilege grant here (see README "Residual risk").
  statement {
    sid     = "PassEcsRolesOnly"
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      local.execution_role_arn,
      local.task_role_arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "ci_deploy" {
  name   = "${var.role_name}-policy"
  role   = aws_iam_role.ci_deploy.id
  policy = data.aws_iam_policy_document.ci_deploy.json
}
