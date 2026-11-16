# 역할 그룹 5종 (interfaces.md 2장 role) + 데모 계정. 데모 비밀번호는 Secrets Manager 에만 둔다.
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }

locals {
  roles = ["USER", "AUTHOR", "REG_APPROVER", "SECURITY_REVIEWER", "PLATFORM_OPERATOR"]
  demo = {
    "demo-user"     = "USER"
    "demo-author"   = "AUTHOR"
    "demo-approver" = "REG_APPROVER"
    "demo-security" = "SECURITY_REVIEWER"
    "demo-operator" = "PLATFORM_OPERATOR"
  }
}

resource "aws_cognito_user_pool" "this" {
  name                = "${var.n.prefix}-cognito-users${var.n.suffix}"
  deletion_protection = var.n.suffix == "" ? "ACTIVE" : "INACTIVE"
  username_configuration { case_sensitive = false }
  admin_create_user_config { allow_admin_create_user_only = true }
  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
  }
  schema {
    name                = "dept"
    attribute_data_type = "String"
    mutable             = true
    string_attribute_constraints {
      min_length = 0
      max_length = 64
    }
  }
}

resource "aws_cognito_user_pool_client" "web" {
  name                          = "${var.n.prefix}-cognito-web${var.n.suffix}"
  user_pool_id                  = aws_cognito_user_pool.this.id
  generate_secret               = false
  explicit_auth_flows           = ["ALLOW_USER_SRP_AUTH", "ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  access_token_validity         = 60
  id_token_validity             = 60
  refresh_token_validity        = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_user_group" "g" {
  for_each     = toset(local.roles)
  name         = each.key
  user_pool_id = aws_cognito_user_pool.this.id
}

resource "random_password" "demo" {
  for_each         = local.demo
  length           = 20
  special          = true
  override_special = "!@#%^*-_"
  min_lower        = 1
  min_upper        = 1
  min_numeric      = 1
  min_special      = 1
}

resource "aws_cognito_user" "demo" {
  for_each       = local.demo
  user_pool_id   = aws_cognito_user_pool.this.id
  username       = each.key
  password       = random_password.demo[each.key].result
  message_action = "SUPPRESS"
  attributes     = { "dept" = "여신" }
}

resource "aws_cognito_user_in_group" "demo" {
  for_each     = local.demo
  user_pool_id = aws_cognito_user_pool.this.id
  group_name   = aws_cognito_user_group.g[each.value].name
  username     = aws_cognito_user.demo[each.key].username
}

resource "aws_secretsmanager_secret" "demo" {
  name                    = "${var.n.prefix}/demo-users${var.n.suffix}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "demo" {
  secret_id     = aws_secretsmanager_secret.demo.id
  secret_string = jsonencode({ for k, v in local.demo : k => { role = v, password = random_password.demo[k].result } })
}

output "user_pool_id" { value = aws_cognito_user_pool.this.id }
output "client_id" { value = aws_cognito_user_pool_client.web.id }
output "demo_users_secret" { value = aws_secretsmanager_secret.demo.name }
