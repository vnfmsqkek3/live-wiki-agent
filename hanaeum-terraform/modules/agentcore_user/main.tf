variable "protect" {
  type    = bool
  default = false # true: 삭제 보호·저장소 강제 삭제 금지 (stack local.protect)
}
# 사용자 경로 (docs/01 11장, 13항 5 축소 복원): 공유 사용자 Gateway + 가이드 Agent Runtime.
#   Gateway `hanaeum-mvp-gw-user`: CUSTOM_JWT(Cognito access token), REQUEST interceptor 가 tools/call 인자에 `__actor` 주입(dhxorb96)
#     Target = search·regulation·graph·privacy·approval → Tool `{target}___{tool}`. 스키마는 각 tools.json(name·description·inputSchema)
#     Policy ENFORCE: Target 목록만 permit, 그 외 기본 거부 (승인·게시 Tool 은 사용자 Gateway 에 없음)
#   Runtime `hanaeum_mvp_rt_guide`: JWT authorizer, 사용자 토큰(Authorization)을 그대로 Gateway 호출에 사용 (dhxorb96 searchViaGateway)
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }
variable "cognito_user_pool_id" { type = string }
variable "cognito_client_id" { type = string }
variable "interceptor_arn" { type = string }
variable "targets" {
  type = map(object({ lambda_arn = string, tools_json = string })) # Target 이름 → Lambda, tools.json 원문
}
variable "schema_bucket" { type = object({ name = string, arn = string }) }
# Runtime 생성 여부 (plan 시점에 알 수 있어야 함: 이미지 태그는 빌드 뒤에 정해짐)
variable "create_runtime" {
  type    = bool
  default = false
}
variable "image_tag" {
  type    = string
  default = null # null 이면 Runtime 은 만들지 않는다
}
variable "model_sonnet" { type = string }
variable "model_haiku" { type = string } # 가이드 여러 번 찾기 항목 뽑기 (11/18)
# 가이드 출력 PII 검사 (AI팀 PR #69). env 와 ApplyGuardrail IAM 은 함께 있어야 한다: env 만 있으면 가이드 전부 실패(fail-closed)
variable "guardrail" { type = object({ id = string, version = string, arn = string }) }
variable "extra_allowed_clients" {
  type    = list(string)
  default = [] # 외부 MCP 연결 client_credentials 클라이언트 (11/18)
}

data "aws_region" "this" {}
data "aws_caller_identity" "me" {}

locals {
  region    = data.aws_region.this.region
  acct      = data.aws_caller_identity.me.account_id
  discovery = "https://cognito-idp.${local.region}.amazonaws.com/${var.cognito_user_pool_id}/.well-known/openid-configuration"
  # Gateway 에는 MCP Tool 정의 필드만 (진행 문구 progress 등 확장 필드 제외, let522mj 요청)
  # 외부 클라이언트 허용 읽기 도구 (mcp/gateway-interceptor EXTERNAL_TOOLS 와 같게)
  external_tools = ["search___search_wiki", "search___retrieve_evidence", "search___search_legal_clause", "search___get_wiki_document",
    "regulation___get_clause", "regulation___get_official_policy", "regulation___verify_version", "regulation___resolve_reference", "regulation___compare_versions",
  "graph___trace_impact", "graph___get_dependencies"]
  schemas = merge(
    { for k, v in var.targets : k => jsonencode([for t in jsondecode(v.tools_json) : { name = t.name, description = t.description, inputSchema = t.inputSchema }]) },
    # 비인가 게시 거부 시험용 (docs/05 4장, P1). 실행 Tool 아님: Policy forbid 로 모두 거부, 통과해도 approval Lambda 가 unknown tool
    { probe = jsonencode([{ name = "publish_wiki_probe", description = "TEST ONLY: 게시 시도 probe. Policy 로 항상 거부된다", inputSchema = { type = "object", properties = { doc_id = { type = "string" } } } }]) },
  )
}

# ---------- Tool 스키마 ----------
resource "aws_s3_object" "schema" {
  for_each     = local.schemas
  bucket       = var.schema_bucket.name
  key          = "agentcore-tools/user${var.n.suffix}/${each.key}.json"
  content      = each.value
  content_type = "application/json"
  kms_key_id   = var.kms_key_arn
}

# ---------- Gateway ----------
resource "aws_iam_role" "gateway" {
  name = "${var.n.prefix}-role-gw-user${var.n.suffix}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Principal = { Service = "bedrock-agentcore.amazonaws.com" }, Action = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.acct } }
    }]
  })
}

resource "aws_iam_role_policy" "gateway" {
  role = aws_iam_role.gateway.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = flatten([for a in concat([for t in values(var.targets) : t.lambda_arn], [var.interceptor_arn]) : [a, "${a}:*"]]) },
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = [for o in aws_s3_object.schema : "${var.schema_bucket.arn}/${o.key}"] },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arn },
    ]
  })
}

# Policy 평가 권한 (파이프라인 Gateway 와 같은 구조, 순환 방지로 분리)
resource "aws_iam_role_policy" "gateway_policy_engine" {
  role = aws_iam_role.gateway.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["bedrock-agentcore:GetPolicyEngine"], Resource = aws_bedrockagentcore_policy_engine.user.policy_engine_arn },
      {
        Effect   = "Allow", Action = ["bedrock-agentcore:AuthorizeAction", "bedrock-agentcore:PartiallyAuthorizeActions"]
        Resource = [aws_bedrockagentcore_policy_engine.user.policy_engine_arn, "arn:aws:bedrock-agentcore:${local.region}:${local.acct}:gateway/*"]
      },
    ]
  })
}

resource "aws_bedrockagentcore_policy_engine" "user" {
  name        = replace("${var.n.prefix}_pe_user${var.n.suffix}", "-", "_")
  description = "사용자 Gateway 정책 (조회·검토 요청 Tool 만)"
}

resource "aws_bedrockagentcore_gateway" "user" {
  name            = "${var.n.prefix}-gw-user${var.n.suffix}"
  description     = "사용자 가이드 Tool (Cognito JWT, __actor 주입)"
  role_arn        = aws_iam_role.gateway.arn
  authorizer_type = "CUSTOM_JWT"
  protocol_type   = "MCP"
  authorizer_configuration {
    custom_jwt_authorizer {
      discovery_url   = local.discovery
      allowed_clients = concat([var.cognito_client_id], var.extra_allowed_clients)
    }
  }
  interceptor_configuration {
    interception_points = ["REQUEST"]
    interceptor {
      lambda { arn = var.interceptor_arn }
    }
    input_configuration { pass_request_headers = true } # interceptor 가 Authorization 토큰을 다시 검증해 신원 주입
  }
  policy_engine_configuration {
    arn  = aws_bedrockagentcore_policy_engine.user.policy_engine_arn
    mode = "ENFORCE"
  }
  depends_on = [aws_iam_role_policy.gateway_policy_engine, aws_iam_role_policy.gateway]
}

resource "aws_bedrockagentcore_gateway_target" "t" {
  for_each           = var.targets
  gateway_identifier = aws_bedrockagentcore_gateway.user.gateway_id
  name               = each.key
  description        = "사용자 Tool ${each.key}"
  credential_provider_configuration {
    gateway_iam_role {}
  }
  target_configuration {
    mcp {
      lambda {
        lambda_arn = each.value.lambda_arn
        tool_schema {
          s3 { uri = "s3://${var.schema_bucket.name}/${aws_s3_object.schema[each.key].key}" }
        }
      }
    }
  }
  depends_on = [aws_iam_role_policy.gateway]
}

resource "aws_bedrockagentcore_gateway_target" "probe" {
  gateway_identifier = aws_bedrockagentcore_gateway.user.gateway_id
  name               = "probe"
  description        = "비인가 게시 거부 시험 (publish_wiki_probe)"
  credential_provider_configuration {
    gateway_iam_role {}
  }
  target_configuration {
    mcp {
      lambda {
        lambda_arn = var.targets["approval"].lambda_arn
        tool_schema {
          s3 { uri = "s3://${var.schema_bucket.name}/${aws_s3_object.schema["probe"].key}" }
        }
      }
    }
  }
  depends_on = [aws_iam_role_policy.gateway]
}

# user_tools permit 에 probe 가 없어 기본 거부지만, permit 이 넓어져도 막히도록 명시 forbid (forbid 가 항상 이긴다)
resource "aws_bedrockagentcore_policy" "deny_probe" {
  name             = "${replace(var.n.prefix, "-", "_")}_deny_publish_probe${replace(var.n.suffix, "-", "_")}"
  description      = "publish_wiki_probe 는 누구도 호출 불가 (데모 06 Policy 경로)"
  policy_engine_id = aws_bedrockagentcore_policy_engine.user.policy_engine_id
  validation_mode  = "FAIL_ON_ANY_FINDINGS"
  lifecycle { create_before_destroy = true }
  definition {
    cedar {
      statement = <<-CEDAR
        forbid(
          principal,
          action in AgentCore::Action::"probe",
          resource == AgentCore::Gateway::"${aws_bedrockagentcore_gateway.user.gateway_arn}"
        );
      CEDAR
    }
  }
  depends_on = [aws_bedrockagentcore_gateway_target.probe]
}

# 외부 MCP 클라이언트(client_credentials, scope hanaeum-wiki-mcp/read)는 읽기 11개 외 거부 (백엔드 Cedar 문안 11/20, P1).
# 인터셉터 EXTERNAL_TOOLS 와 같은 목록을 Gateway 경계에서 한 번 더. 내부 사용자 토큰은 scope 태그가 달라 when 이 거짓 → 영향 없음
resource "aws_bedrockagentcore_policy" "external_readonly" {
  name             = "${replace(var.n.prefix, "-", "_")}_user_external_readonly${replace(var.n.suffix, "-", "_")}"
  description      = "외부 MCP 클라이언트(hanaeum-wiki-mcp/read): 읽기 도구 11개 외 거부 (인터셉터 EXTERNAL_TOOLS와 같은 목록)"
  policy_engine_id = aws_bedrockagentcore_policy_engine.user.policy_engine_id
  validation_mode  = "FAIL_ON_ANY_FINDINGS"
  lifecycle { create_before_destroy = true }
  definition {
    cedar {
      statement = <<-CEDAR
        forbid(
          principal is AgentCore::OAuthUser,
          action,
          resource == AgentCore::Gateway::"${aws_bedrockagentcore_gateway.user.gateway_arn}"
        ) when {
          principal.hasTag("scope") && principal.getTag("scope") like "*hanaeum-wiki-mcp/read*"
        } unless {
          action in [${join(", ", [for t in local.external_tools : "AgentCore::Action::\"${t}\""])}]
        };
      CEDAR
    }
  }
  depends_on = [aws_bedrockagentcore_gateway_target.t]
}

resource "aws_bedrockagentcore_policy" "user_tools" {
  # 이름은 계정 단위로 유일 (prod 11/17 실측) → 환경 포함. 교체 시 새 것 먼저
  name             = "${replace(var.n.prefix, "-", "_")}_user_tools${replace(var.n.suffix, "-", "_")}"
  description      = "인증된 사용자: 조회·검토 요청 Target 만 (그 외 기본 거부)"
  policy_engine_id = aws_bedrockagentcore_policy_engine.user.policy_engine_id
  validation_mode  = "FAIL_ON_ANY_FINDINGS"
  lifecycle { create_before_destroy = true }
  definition {
    cedar {
      statement = <<-CEDAR
        permit(
          principal,
          action in [${join(", ", [for t in keys(var.targets) : "AgentCore::Action::\"${t}\""])}],
          resource == AgentCore::Gateway::"${aws_bedrockagentcore_gateway.user.gateway_arn}"
        );
      CEDAR
    }
  }
  depends_on = [aws_bedrockagentcore_gateway_target.t]
}

# Gateway 는 도구 스키마·Cedar 행동 목록을 만들 때만 읽는다(11/18 get_wiki_document 미반영 실측). 대상을 다시 만들면 이름 충돌 →
# 스키마가 바뀌면 같은 설정으로 update 를 다시 불러 반영한다
resource "terraform_data" "resync" {
  triggers_replace = [sha1(join("", values(local.schemas)))]
  provisioner "local-exec" {
    command = "${path.module}/../../scripts/agentcore-resync.sh ${aws_bedrockagentcore_gateway.user.gateway_id} ${aws_bedrockagentcore_policy_engine.user.policy_engine_id} ${aws_bedrockagentcore_policy.user_tools.policy_id}"
  }
}

# ---------- 가이드 Runtime ----------
resource "aws_ecr_repository" "guide" {
  name                 = "${var.n.prefix}-ecr-guide${var.n.suffix}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = !var.protect
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

resource "aws_iam_role" "runtime" {
  name = "${var.n.prefix}-role-rt-guide${var.n.suffix}"
  tags = { "hanaeum-model-caller" = "true" } # 원본·work 읽기 거부 대상
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Principal = { Service = "bedrock-agentcore.amazonaws.com" }, Action = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.acct } }
    }]
  })
}

resource "aws_iam_role_policy" "runtime" {
  role = aws_iam_role.runtime.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"], Resource = ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:${local.region}:${local.acct}:inference-profile/*"] },
      { Effect = "Allow", Action = ["bedrock:ApplyGuardrail"], Resource = var.guardrail.arn },
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = aws_ecr_repository.guide.arn },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arn },
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:DescribeLogGroups"], Resource = "arn:aws:logs:${local.region}:${local.acct}:log-group:/aws/bedrock-agentcore/*" },
      { Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets", "cloudwatch:PutMetricData"], Resource = "*" },
      { Effect = "Allow", Action = ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT", "bedrock-agentcore:GetWorkloadAccessTokenForUserId"], Resource = "*" },
    ]
  })
}

resource "aws_bedrockagentcore_agent_runtime" "guide" {
  count              = var.create_runtime ? 1 : 0
  agent_runtime_name = replace("${var.n.prefix}_rt_guide${var.n.suffix}", "-", "_")
  description        = "사용자 가이드 Agent (Strands, 사용자 Gateway Tool 만)"
  role_arn           = aws_iam_role.runtime.arn
  agent_runtime_artifact {
    container_configuration { container_uri = "${aws_ecr_repository.guide.repository_url}:${var.image_tag}" }
  }
  network_configuration { network_mode = "PUBLIC" }
  authorizer_configuration {
    custom_jwt_authorizer {
      discovery_url   = local.discovery
      allowed_clients = [var.cognito_client_id]
    }
  }
  # 사용자 토큰을 Runtime 코드까지 전달 → 같은 토큰으로 Gateway 호출
  request_header_configuration { request_header_allowlist = ["Authorization"] }
  environment_variables = {
    GATEWAY_URL       = aws_bedrockagentcore_gateway.user.gateway_url
    MODEL_SONNET      = var.model_sonnet
    MODEL_HAIKU       = var.model_haiku
    AWS_REGION        = local.region
    GUARDRAIL_ID      = var.guardrail.id
    GUARDRAIL_VERSION = var.guardrail.version
  }
  depends_on = [aws_iam_role_policy.runtime, aws_bedrockagentcore_policy.user_tools]
}

output "gateway_url" { value = aws_bedrockagentcore_gateway.user.gateway_url }
output "ecr_repository_name" { value = aws_ecr_repository.guide.name }
output "ecr_repository_arn" { value = aws_ecr_repository.guide.arn }
output "runtime_arn" { value = try(aws_bedrockagentcore_agent_runtime.guide[0].agent_runtime_arn, "") }
output "runtime_arn_pattern" { value = "arn:aws:bedrock-agentcore:${local.region}:${local.acct}:runtime/${replace("${var.n.prefix}_rt_guide${var.n.suffix}", "-", "_")}-*" }
