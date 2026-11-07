# ---------------------------------------------------------------------------
# VPC
# ---------------------------------------------------------------------------
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "lpms-pilot-vpc"
  }
}

# ---------------------------------------------------------------------------
# Internet Gateway
# ---------------------------------------------------------------------------
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "lpms-pilot-igw"
  }
}

# ---------------------------------------------------------------------------
# Public subnets (2 AZs — ALB requires ≥2)
# ---------------------------------------------------------------------------
resource "aws_subnet" "public_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.public_subnet_cidrs[0]
  availability_zone = "${var.aws_region}a"

  tags = {
    Name = "lpms-pilot-public-a"
  }
}

resource "aws_subnet" "public_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.public_subnet_cidrs[1]
  availability_zone = "${var.aws_region}b"

  tags = {
    Name = "lpms-pilot-public-b"
  }
}

# ---------------------------------------------------------------------------
# Private subnets (2 AZs — RDS subnet group requires ≥2)
# ---------------------------------------------------------------------------
resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[0]
  availability_zone = "${var.aws_region}a"

  tags = {
    Name = "lpms-pilot-private-a"
  }
}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[1]
  availability_zone = "${var.aws_region}b"

  tags = {
    Name = "lpms-pilot-private-b"
  }
}

# ---------------------------------------------------------------------------
# Public route table (default route → IGW)
# ---------------------------------------------------------------------------
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "lpms-pilot-public-rt"
  }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

# ---------------------------------------------------------------------------
# Private route table (no default route — no NAT by design, saves ~$32/mo)
# ---------------------------------------------------------------------------
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "lpms-pilot-private-rt"
  }
}

resource "aws_route_table_association" "private_a" {
  subnet_id      = aws_subnet.private_a.id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "private_b" {
  subnet_id      = aws_subnet.private_b.id
  route_table_id = aws_route_table.private.id
}

# ---------------------------------------------------------------------------
# ALB Security Group — inbound 80+443 from operator allowlist only
# :80 is kept only for the HTTP→HTTPS 301 redirect; no plaintext app traffic.
# ---------------------------------------------------------------------------
resource "aws_security_group" "alb" {
  name        = "lpms-pilot-alb-sg"
  description = "ALB: HTTPS (443) + HTTP (80, redirect only) from allowed CIDRs."
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS from allowed CIDRs"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.alb_ingress_cidrs
  }

  ingress {
    description = "HTTP from allowed CIDRs (301 redirect to HTTPS only)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.alb_ingress_cidrs
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "lpms-pilot-alb-sg"
  }
}

# ---------------------------------------------------------------------------
# Fargate Security Group — inbound :3000 from ALB SG only; full egress via IGW
# (Fargate runs in public subnet with a public IP; reachable only from ALB.)
# ---------------------------------------------------------------------------
resource "aws_security_group" "fargate" {
  name        = "lpms-pilot-fargate-sg"
  description = "Fargate: inbound 3000 from ALB SG only; egress unrestricted (IGW)."
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "App port from ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "Allow all outbound (ECR / Bedrock / Secrets Manager / CloudWatch via IGW)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "lpms-pilot-fargate-sg"
  }
}

# ---------------------------------------------------------------------------
# RDS Security Group — inbound :5432 from Fargate SG only
# ---------------------------------------------------------------------------
resource "aws_security_group" "rds" {
  name        = "lpms-pilot-rds-sg"
  description = "RDS: inbound 5432 from Fargate SG only."
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from Fargate"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.fargate.id]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "lpms-pilot-rds-sg"
  }
}
