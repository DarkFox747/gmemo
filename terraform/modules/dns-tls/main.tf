# ---------------------------------------------------------------------------
# Route53 hosted zone — look up existing or create new
# ---------------------------------------------------------------------------
data "aws_route53_zone" "main" {
  count = var.create_hosted_zone ? 0 : 1

  name         = var.route53_zone_name
  private_zone = false
}

resource "aws_route53_zone" "main" {
  count = var.create_hosted_zone ? 1 : 0

  name = var.route53_zone_name

  tags = {
    Name = "lpms-pilot-zone"
  }
}

locals {
  zone_id = var.create_hosted_zone ? aws_route53_zone.main[0].zone_id : data.aws_route53_zone.main[0].zone_id
}

# ---------------------------------------------------------------------------
# ACM certificate — DNS-validated, same region as ALB (us-east-1 default provider).
# No second provider alias needed — the whole pilot is us-east-1.
# ---------------------------------------------------------------------------
resource "aws_acm_certificate" "main" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "lpms-pilot-cert"
  }
}

# ---------------------------------------------------------------------------
# DNS validation CNAME records — one per domain_validation_options entry
# ---------------------------------------------------------------------------
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = local.zone_id
}

# ---------------------------------------------------------------------------
# Wait for the certificate to reach ISSUED status.
# apply blocks here until ACM confirms DNS validation is complete.
# If create_hosted_zone=true: complete NS delegation at the registrar FIRST.
# ---------------------------------------------------------------------------
resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}
