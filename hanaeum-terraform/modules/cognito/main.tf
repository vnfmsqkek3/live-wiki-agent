# 역할 그룹 5종 (interfaces.md 2장 role) + 데모 계정. 데모 비밀번호는 Secrets Manager 에만 둔다.
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }
# auth-triggers.zip (lambda_build 모듈이 CodeBuild 로 빌드)
variable "lambda_s3" { type = object({ bucket = string, key = string }) }

locals {
  roles = ["USER", "AUTHOR", "REG_APPROVER", "SECURITY_REVIEWER", "PLATFORM_OPERATOR"]
  # 데모 계정은 admin·user 두 종류 (사용자 결정 11/17). 앱 권한은 기존 역할 그룹으로 판단하므로 그룹 조합으로 표현.
  # user 는 문서 등록(AUTHOR)까지, 승인·보안 검토·운영은 admin. 자기 승인 금지(interfaces.md 7.1)라 user 가 올리고 admin 이 승인한다
  demo = {
    "user"  = ["USER", "AUTHOR"]
    "admin" = local.roles
  }
  demo_groups = merge([for u, gs in local.demo : { for g in gs : "${u}/${g}" => { user = u, group = g } }]...)
}

resource "aws_cognito_user_pool" "this" {
  name                = "${var.n.prefix}-cognito-users${var.n.suffix}"
  deletion_protection = var.n.suffix == "" ? "ACTIVE" : "INACTIVE"
  user_pool_tier      = "ESSENTIALS" # Pre Token Generation V2(access token 커스텀 claim) 필요
  lambda_config {
    pre_token_generation_config {
      lambda_arn     = aws_lambda_function.pre_token.arn
      lambda_version = "V2_0"
    }
  }
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

# ---------- Pre Token Generation V2: access token 에 dept claim ----------

resource "aws_iam_role" "pre_token" {
  name = "${var.n.prefix}-role-pretoken${var.n.suffix}"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "pre_token" {
  role       = aws_iam_role.pre_token.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "pre_token" {
  name              = "/aws/lambda/${var.n.prefix}-lambda-pretoken${var.n.suffix}"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn
}

resource "aws_lambda_function" "pre_token" {
  function_name = "${var.n.prefix}-lambda-pretoken${var.n.suffix}"
  role          = aws_iam_role.pre_token.arn
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  handler       = "pre-token.handler"
  s3_bucket     = var.lambda_s3.bucket
  s3_key        = var.lambda_s3.key
  timeout       = 5
  depends_on    = [aws_cloudwatch_log_group.pre_token]
}

resource "aws_lambda_permission" "cognito" {
  statement_id  = "AllowCognito"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.pre_token.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.this.arn
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
  for_each     = local.demo_groups
  user_pool_id = aws_cognito_user_pool.this.id
  group_name   = aws_cognito_user_group.g[each.value.group].name
  username     = aws_cognito_user.demo[each.value.user].username
}

resource "aws_secretsmanager_secret" "demo" {
  name                    = "${var.n.prefix}/demo-users${var.n.suffix}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "demo" {
  secret_id     = aws_secretsmanager_secret.demo.id
  secret_string = jsonencode({ for k, v in local.demo : k => { roles = v, password = random_password.demo[k].result } })
}

output "user_pool_id" { value = aws_cognito_user_pool.this.id }
output "client_id" { value = aws_cognito_user_pool_client.web.id }
output "demo_users_secret" { value = aws_secretsmanager_secret.demo.name }
