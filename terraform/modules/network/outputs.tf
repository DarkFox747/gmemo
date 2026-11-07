output "vpc_id" {
  description = "VPC ID."
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "Public subnet IDs [AZ-a, AZ-b] — used by ALB and Fargate task."
  value       = [aws_subnet.public_a.id, aws_subnet.public_b.id]
}

output "private_subnet_ids" {
  description = "Private subnet IDs [AZ-a, AZ-b] — used by the RDS DB subnet group."
  value       = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}

output "alb_sg_id" {
  description = "ALB security group ID."
  value       = aws_security_group.alb.id
}

output "fargate_sg_id" {
  description = "Fargate security group ID."
  value       = aws_security_group.fargate.id
}

output "rds_sg_id" {
  description = "RDS security group ID."
  value       = aws_security_group.rds.id
}
