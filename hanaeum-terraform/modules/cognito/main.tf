data "aws_region" "current" {}
# 역할 그룹 5종 (interfaces.md 2장 role) + 데모 계정. 데모 비밀번호는 Secrets Manager 에만 둔다.
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }
# auth-triggers.zip (lambda_build 모듈이 CodeBuild 로 빌드)
variable "lambda_s3" { type = object({ bucket = string, key = string }) }
# 데모 계정 공통 비밀번호 (사용자 지정 11/17). 값은 git 에 두지 않고 TF_VAR_demo_password(.env.local)로만. null 이면 무작위
variable "demo_password" {
  type      = string
  default   = null
  sensitive = true
}

locals {
  roles = ["USER", "AUTHOR", "REG_APPROVER", "SECURITY_REVIEWER", "PLATFORM_OPERATOR"]
  # 데모 계정은 admin·user 두 종류 (사용자 결정 11/17). 앱 권한은 기존 역할 그룹으로 판단하므로 그룹 조합으로 표현.
  # user 는 문서 등록(AUTHOR)까지, 승인·보안 검토·운영은 admin. 자기 승인 금지(interfaces.md 7.1)라 user 가 올리고 admin 이 승인한다
  demo = {
    "user"  = ["USER", "AUTHOR"]
    "admin" = local.roles
    # 두 번째 결재자 (11/18): admin 이 올린 문서는 자기 승인 금지라 결재할 사람이 없었음
    "approver" = ["USER", "AUTHOR", "REG_APPROVER", "SECURITY_REVIEWER"]
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
    minimum_length    = var.n.suffix == "" ? 10 : 8 # 데모 공통 비밀번호(10자, 사용자 지시 dev·prod 통일). 대소문자·숫자·기호 정책은 유지
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
  password       = coalesce(var.demo_password, random_password.demo[each.key].result)
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
  secret_string = jsonencode({ for k, v in local.demo : k => { roles = v, password = coalesce(var.demo_password, random_password.demo[k].result) } })
}

# 외부 MCP 연결 (사용자 요구 11/18: 다른 챗봇·문서 생성 앱이 같은 Gateway 도구를 쓰게). 서버 간 client_credentials, 읽기 범위만.
# 사람 사용자 없이 들어오므로 Gateway interceptor 가 acl ALL(공개) 문서·읽기 도구만 허용한다(dhxorb96).
resource "random_id" "auth_domain" { byte_length = 3 }

resource "aws_cognito_user_pool_domain" "this" {
  domain       = "${var.n.prefix}-auth${var.n.suffix}-${random_id.auth_domain.hex}"
  user_pool_id = aws_cognito_user_pool.this.id
}

resource "aws_cognito_resource_server" "mcp" {
  identifier   = "hanaeum-wiki-mcp"
  name         = "${var.n.prefix}-wiki-mcp${var.n.suffix}"
  user_pool_id = aws_cognito_user_pool.this.id
  scope {
    scope_name        = "read"
    scope_description = "위키 검색·근거·규정·그래프·정리본 읽기"
  }
}

resource "aws_cognito_user_pool_client" "mcp_external" {
  name                                 = "${var.n.prefix}-cognito-mcp-external${var.n.suffix}"
  user_pool_id                         = aws_cognito_user_pool.this.id
  generate_secret                      = true
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["client_credentials"]
  allowed_oauth_scopes                 = ["${aws_cognito_resource_server.mcp.identifier}/read"]
  supported_identity_providers         = ["COGNITO"]
  access_token_validity                = 60
  token_validity_units { access_token = "minutes" }
}

resource "aws_secretsmanager_secret" "mcp_external" {
  name                    = "${var.n.prefix}/mcp-external-client${var.n.suffix}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "mcp_external" {
  secret_id = aws_secretsmanager_secret.mcp_external.id
  secret_string = jsonencode({
    client_id      = aws_cognito_user_pool_client.mcp_external.id
    client_secret  = aws_cognito_user_pool_client.mcp_external.client_secret
    token_endpoint = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.region}.amazoncognito.com/oauth2/token"
    scope          = "${aws_cognito_resource_server.mcp.identifier}/read"
  })
}

output "mcp_external_client_id" { value = aws_cognito_user_pool_client.mcp_external.id }
output "mcp_external_secret" { value = aws_secretsmanager_secret.mcp_external.name }

output "user_pool_id" { value = aws_cognito_user_pool.this.id }
output "client_id" { value = aws_cognito_user_pool_client.web.id }
output "demo_users_secret" { value = aws_secretsmanager_secret.demo.name }
