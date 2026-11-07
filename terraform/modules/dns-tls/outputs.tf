output "certificate_arn" {
  description = "Validated ACM certificate ARN → service module HTTPS listener."
  value       = aws_acm_certificate_validation.main.certificate_arn
}

output "zone_id" {
  description = "Route53 hosted zone ID → service module A/AAAA alias records."
  value       = local.zone_id
}

output "name_servers" {
  description = "Route53 hosted zone name servers. Populated only when create_hosted_zone=true. Complete NS delegation at the registrar and wait for propagation before ACM DNS validation can succeed."
  value       = var.create_hosted_zone ? aws_route53_zone.main[0].name_servers : null
}
