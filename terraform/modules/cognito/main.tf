data "aws_region" "current" {}

# ---------------------------------------------------------------------------
# User pool — admin-provisioned only, email sign-in, strong password policy.
# No hosted UI, no federation, no groups (RBAC stays in RDS Gate 2).
# No SES: invites are suppressed, so the Cognito email path is never used.
# ---------------------------------------------------------------------------
resource "aws_cognito_user_pool" "main" {
  name = var.user_pool_name

  # Admin-only user creation — self sign-up disabled
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  # Sign in with email (not username)
  username_attributes = ["email"]

  # Strong password policy
  password_policy {
    minimum_length                   = 12
    require_uppercase                = true
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  # OPTIONAL MFA — users may enrol TOTP (no SES/SMS cost). Enforce per-user via:
  #   aws cognito-idp admin-set-user-mfa-preference \
  #     --software-token-mfa-settings Enabled=true,PreferredMfa=true \
  #     --user-pool-id <pool-id> --username <email>
  mfa_configuration = "OPTIONAL"

  software_token_mfa_configuration {
    enabled = true
  }

  tags = {
    Name = "gmemo-pilot-user-pool"
  }
}

# ---------------------------------------------------------------------------
# App client — public (no secret), USER_PASSWORD_AUTH only, short TTLs.
# No OAuth flows / callback URLs — USER_PASSWORD_AUTH doesn't need them.
# The required scope (aws.cognito.signin.user.admin) is on every token minted
# via USER_PASSWORD_AUTH; no resource server or custom scope is needed.
# ---------------------------------------------------------------------------
resource "aws_cognito_user_pool_client" "main" {
  name         = var.app_client_name
  user_pool_id = aws_cognito_user_pool.main.id

  # Public client — no secret to distribute
  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  access_token_validity  = var.access_token_validity_minutes
  id_token_validity      = var.access_token_validity_minutes
  refresh_token_validity = 1

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  # No OAuth/hosted-UI flows — not needed for USER_PASSWORD_AUTH
  allowed_oauth_flows_user_pool_client = false
}

# ---------------------------------------------------------------------------
# Authorized users — declarative list, no password in Terraform.
# Users start in FORCE_CHANGE_PASSWORD; operator sets a permanent password:
#   aws cognito-idp admin-set-user-password --permanent \
#     --user-pool-id <id> --username <email> --password <password>
# ---------------------------------------------------------------------------
resource "aws_cognito_user" "authorized" {
  for_each = toset(var.authorized_user_emails)

  user_pool_id = aws_cognito_user_pool.main.id
  username     = each.value

  # Suppress invite email — operator sets password out-of-band
  message_action = "SUPPRESS"

  # NO password attribute — keeps user secrets out of Terraform state (FLAG 5).

  attributes = {
    email          = each.value
    email_verified = "true"
  }
}
