variable "domain_name" {
  description = "FQDN the pilot answers on (e.g. gmemo-pilot.example-fake.dev)."
  type        = string
}

variable "route53_zone_name" {
  description = "Parent Route53 hosted zone name (e.g. example-fake.dev). Used to look up an existing zone or create a new one."
  type        = string
}

variable "create_hosted_zone" {
  description = "When false (default), look up an existing Route53 hosted zone by route53_zone_name. When true, create the zone and output name_servers for NS delegation at the registrar — delegation must complete before ACM DNS validation can succeed."
  type        = bool
  default     = false
}
