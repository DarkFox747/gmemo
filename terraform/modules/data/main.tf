# ---------------------------------------------------------------------------
# DB password — URL-hostile chars excluded so DATABASE_URL needs no encoding.
# The result lives in Terraform state (FLAG 5 — mitigated by encrypted S3 backend).
# ---------------------------------------------------------------------------
resource "random_password" "db" {
  length           = 32
  special          = true
  override_special = "!$&*-_=+"
}

# ---------------------------------------------------------------------------
# DB subnet group — spans both private subnets (RDS subnet group requires ≥2 AZs)
# ---------------------------------------------------------------------------
resource "aws_db_subnet_group" "main" {
  name       = "gmemo-pilot-db-subnet-group"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name = "gmemo-pilot-db-subnet-group"
  }
}

# ---------------------------------------------------------------------------
# DB parameter group — rds.force_ssl=1 (server-side TLS enforcement, FLAG 4)
# ---------------------------------------------------------------------------
resource "aws_db_parameter_group" "main" {
  name   = "gmemo-pilot-pg16"
  family = var.db_parameter_group_family

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  tags = {
    Name = "gmemo-pilot-pg16"
  }
}

# ---------------------------------------------------------------------------
# RDS instance — db.t4g.micro, pg16, 20 GB gp3, encrypted, single-AZ, private
# ---------------------------------------------------------------------------
resource "aws_db_instance" "main" {
  identifier = "gmemo-pilot"

  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  allocated_storage = var.db_allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "gmemo"
  username = "gmemo_master"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.rds_sg_id]
  parameter_group_name   = aws_db_parameter_group.main.name

  multi_az            = false
  publicly_accessible = false

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "gmemo-pilot-final"
  backup_retention_period   = 7

  tags = {
    Name = "gmemo-pilot"
  }
}

# ---------------------------------------------------------------------------
# Secrets Manager — stores DATABASE_URL as a JSON key so ECS can mount it with
# "valueFrom": "<arn>:DATABASE_URL::"
# ---------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "app" {
  name = var.secret_name

  recovery_window_in_days = 7

  tags = {
    Name = "gmemo-pilot-app"
  }
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id

  secret_string = jsonencode({
    DATABASE_URL = "postgresql://gmemo_master:${random_password.db.result}@${aws_db_instance.main.endpoint}/gmemo"
  })
}
