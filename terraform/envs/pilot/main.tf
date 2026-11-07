module "network" {
  source = "../../modules/network"

  aws_region           = var.aws_region
  vpc_cidr             = var.vpc_cidr
  public_subnet_cidrs  = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs
  alb_ingress_cidrs    = var.alb_ingress_cidrs
}

module "data" {
  source = "../../modules/data"

  private_subnet_ids = module.network.private_subnet_ids
  rds_sg_id          = module.network.rds_sg_id
}

module "cognito" {
  source = "../../modules/cognito"

  authorized_user_emails = var.authorized_user_emails
}

module "dns_tls" {
  source = "../../modules/dns-tls"

  domain_name        = var.domain_name
  route53_zone_name  = var.route53_zone_name
  create_hosted_zone = var.create_hosted_zone
}

module "service" {
  source = "../../modules/service"

  aws_region        = var.aws_region
  vpc_id            = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids
  alb_sg_id         = module.network.alb_sg_id
  fargate_sg_id     = module.network.fargate_sg_id
  secret_arn        = module.data.secret_arn

  image_tag     = var.image_tag
  task_cpu      = var.task_cpu
  task_memory   = var.task_memory
  desired_count = var.desired_count

  bedrock_model_arns         = var.bedrock_model_arns
  bedrock_model_id           = var.bedrock_model_id
  bedrock_embedding_model_id = var.bedrock_embedding_model_id

  cognito_user_pool_id  = module.cognito.user_pool_id
  cognito_app_client_id = module.cognito.app_client_id
  github_oidc_audience  = var.github_oidc_audience

  certificate_arn = module.dns_tls.certificate_arn
  route53_zone_id = module.dns_tls.zone_id
  domain_name     = var.domain_name
}
