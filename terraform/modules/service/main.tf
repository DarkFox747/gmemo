# ---------------------------------------------------------------------------
# ECR repository
# ---------------------------------------------------------------------------
resource "aws_ecr_repository" "app" {
  name                 = "lpms-pilot-app"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "lpms-pilot-app"
  }
}

# ---------------------------------------------------------------------------
# CloudWatch log group
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "app" {
  name              = "/lpms/pilot/app"
  retention_in_days = 30

  tags = {
    Name = "lpms-pilot-app"
  }
}

# ---------------------------------------------------------------------------
# ECS cluster
# ---------------------------------------------------------------------------
resource "aws_ecs_cluster" "main" {
  name = "lpms-pilot"

  tags = {
    Name = "lpms-pilot"
  }
}

# ---------------------------------------------------------------------------
# IAM — shared assume-role policy for both ECS roles
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "ecs_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------------------
# Execution role — ECR pull + CloudWatch Logs + Secrets Manager (scoped to secret)
# ---------------------------------------------------------------------------
resource "aws_iam_role" "execution" {
  name               = "lpms-pilot-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json

  tags = {
    Name = "lpms-pilot-execution-role"
  }
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid       = "ReadAppSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.secret_arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "lpms-pilot-execution-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# ---------------------------------------------------------------------------
# Task role — least-privilege Bedrock only (InvokeModel + Converse on model ARNs)
# ---------------------------------------------------------------------------
resource "aws_iam_role" "task" {
  name               = "lpms-pilot-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json

  tags = {
    Name = "lpms-pilot-task-role"
  }
}

data "aws_iam_policy_document" "task_bedrock" {
  statement {
    sid = "InvokeBedrockModels"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:Converse",
    ]
    # Explicit model ARNs (FLAG 6: include inference-profile + foundation-model ARNs)
    resources = var.bedrock_model_arns
  }
}

resource "aws_iam_role_policy" "task_bedrock" {
  name   = "lpms-pilot-task-bedrock"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_bedrock.json
}

# ---------------------------------------------------------------------------
# ECS task definition
# Production env block: all bypass/stub flags OFF; real Cognito + Bedrock + RDS TLS.
# Only DATABASE_URL is a secrets entry; everything else is non-secret environment.
# ---------------------------------------------------------------------------
resource "aws_ecs_task_definition" "app" {
  family                   = "lpms-pilot-app"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.task_cpu)
  memory                   = tostring(var.task_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "app"
      image     = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
      essential = true

      portMappings = [
        {
          containerPort = 3000
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = "3000" },
        { name = "HOST", value = "0.0.0.0" },
        { name = "LOG_LEVEL", value = "info" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AUTH_DEV_BYPASS", value = "false" },
        { name = "PROMOTE_OIDC_DEV_BYPASS", value = "false" },
        { name = "JUDGE_STUB", value = "false" },
        { name = "EMBEDDER_STUB", value = "false" },
        { name = "BEDROCK_MODEL_ID", value = var.bedrock_model_id },
        { name = "BEDROCK_EMBEDDING_MODEL_ID", value = var.bedrock_embedding_model_id },
        { name = "COGNITO_USER_POOL_ID", value = var.cognito_user_pool_id },
        { name = "COGNITO_CLIENT_ID_ALLOWLIST", value = var.cognito_app_client_id },
        { name = "COGNITO_REQUIRED_SCOPE", value = "aws.cognito.signin.user.admin" },
        { name = "GITHUB_OIDC_AUDIENCE", value = var.github_oidc_audience },
        { name = "NODE_EXTRA_CA_CERTS", value = var.node_extra_ca_certs },
        { name = "RATE_LIMIT_ENABLED", value = "true" },
      ]

      secrets = [
        {
          name      = "DATABASE_URL"
          valueFrom = "${var.secret_arn}:DATABASE_URL::"
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "app"
        }
      }
    }
  ])

  tags = {
    Name = "lpms-pilot-app"
  }
}

# ---------------------------------------------------------------------------
# ALB — internet-facing, 2 public subnets
# ---------------------------------------------------------------------------
resource "aws_lb" "main" {
  name               = "lpms-pilot-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.alb_sg_id]
  subnets            = var.public_subnet_ids

  tags = {
    Name = "lpms-pilot-alb"
  }
}

# ---------------------------------------------------------------------------
# Target group — ip target type, port 3000, health check /health
# ---------------------------------------------------------------------------
resource "aws_lb_target_group" "app" {
  name        = "lpms-pilot-tg"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name = "lpms-pilot-tg"
  }
}

# ---------------------------------------------------------------------------
# :443 HTTPS listener — TLS terminates here (FLAG 7 resolved); modern TLS policy
# ---------------------------------------------------------------------------
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# ---------------------------------------------------------------------------
# :80 HTTP listener — 301 redirect to :443; no plaintext forwarding
# ---------------------------------------------------------------------------
resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# ---------------------------------------------------------------------------
# Route53 ALIAS records — domain_name → ALB
# Lives here (not in dns-tls) because it needs aws_lb.main.dns_name / zone_id.
# ---------------------------------------------------------------------------
resource "aws_route53_record" "alb_a" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# ---------------------------------------------------------------------------
# ECS service
# ---------------------------------------------------------------------------
resource "aws_ecs_service" "app" {
  name            = "lpms-pilot-app"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.public_subnet_ids
    security_groups  = [var.fargate_sg_id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = 3000
  }

  # Ignore task_definition to prevent unintended redeployments on Terraform apply.
  # To force a new deployment after pushing a new image: use the AWS console/CLI
  # or remove this block temporarily.
  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [
    aws_lb_listener.https,
    aws_iam_role_policy_attachment.execution_managed,
  ]

  tags = {
    Name = "lpms-pilot-app"
  }
}
