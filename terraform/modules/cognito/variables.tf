variable "user_pool_name" {
  description = "Cognito user pool name."
  type        = string
  default     = "lpms-pilot-pool"
}

variable "app_client_name" {
  description = "Cognito app client name."
  type        = string
  default     = "lpms-pilot-client"
}

variable "authorized_user_emails" {
  description = "List of email addresses to provision as Cognito users. Users are created with SUPPRESS (no invite email) and NO password in Terraform — operator sets a permanent password out-of-band via admin-set-user-password."
  type        = list(string)
}

variable "access_token_validity_minutes" {
  description = "Access token (and ID token) validity in minutes. Short TTL bounds replay window."
  type        = number
  default     = 15
}
