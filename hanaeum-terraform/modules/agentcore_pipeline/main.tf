# 문서 처리 오케스트레이션 (긴급 요청 11/16 dhxorb96_to_team: Step Functions → AgentCore).
#   Gateway `hanaeum-mvp-gw-pipeline`(AWS_IAM, 시스템 전용): 단계 Lambda = Tool (이름 = 단계 키)
#   Runtime `hanaeum_mvp_rt_pipeline`(IAM): Strands Graph 오케스트레이터 (코드 dhxorb96 agents/). 이미지가 생기면 생성
#   권한: 파이프라인 Gateway 호출은 오케스트레이터 Role 만 (InvokeGateway IAM)
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }
variable "step_arns" { type = map(string) } # 단계 키 → Lambda ARN
variable "tables" { type = map(object({ name = string, arn = string })) }
variable "runtime_image" {
  type    = string
  default = null # ECR 이미지 URI. null 이면 Runtime 은 만들지 않는다
}
variable "runtime_env" {
  type    = map(string)
  default = {}
}

data "aws_region" "this" {}
data "aws_caller_identity" "me" {}

locals {
  region       = data.aws_region.this.region
  acct         = data.aws_caller_identity.me.account_id
  runtime_name = replace("${var.n.prefix}_rt_pipeline${var.n.suffix}", "-", "_")
  # task token 방식 폐기 → wait_for_approval 은 Tool 로 등록하지 않음
  steps = { for k, v in var.step_arns : k => v if k != "wait_for_approval" }
}

# ---------- Gateway ----------
resource "aws_iam_role" "gateway" {
  name = "${var.n.prefix}-role-gw-pipeline${var.n.suffix}"
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
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = distinct(concat(values(local.steps), [for a in values(local.steps) : "${a}:*"])) }]
  })
}

resource "aws_bedrockagentcore_gateway" "pipeline" {
  name            = "${var.n.prefix}-gw-pipeline${var.n.suffix}"
  description     = "문서 처리 단계 Tool (시스템 전용, AWS_IAM)"
  role_arn        = aws_iam_role.gateway.arn
  authorizer_type = "AWS_IAM"
  protocol_type   = "MCP"
  # 시스템 전용 Gateway: 오케스트레이터가 단계 예외 원인(예: OriginalNotFound)을 STEP# 기록에 남기도록 상세 오류 반환.
  # 단계 예외 메시지에는 PII 를 넣지 않는다 (interfaces.md 6장)
  exception_level = "DEBUG"
  # ponytail: AWS 관리 키. Gateway 에는 Tool 설정만 있고 문서 데이터는 없음.
  # CMK 를 쓰려면 KMS 키 정책에 bedrock-agentcore 서비스 권한 추가 필요 (트러블슈팅 11/16)
}

resource "aws_bedrockagentcore_gateway_target" "step" {
  for_each           = local.steps
  gateway_identifier = aws_bedrockagentcore_gateway.pipeline.gateway_id
  name               = replace(each.key, "_", "-") # Target 이름은 밑줄 불가. Tool 이름 = 단계 키
  description        = "문서 처리 단계 ${each.key}"
  credential_provider_configuration {
    gateway_iam_role {}
  }
  target_configuration {
    mcp {
      lambda {
        lambda_arn = each.value
        tool_schema {
          inline_payload {
            name        = each.key
            description = "단계 ${each.key}. 입력 interfaces.md 6장 공통 입력, 출력 {status: OK|REVIEW_REQUIRED|BLOCKED|PENDING, output_key?, findings?}"
            input_schema {
              type = "object"
              property {
                name     = "workflow_id"
                type     = "string"
                required = true
              }
              property {
                name     = "doc_id"
                type     = "string"
                required = true
              }
              property {
                name     = "version"
                type     = "number"
                required = true
              }
              property {
                name     = "bucket"
                type     = "string"
                required = true
              }
              property {
                name     = "prefix"
                type     = "string"
                required = true
              }
              property {
                name     = "actor"
                type     = "object"
                required = true
                property {
                  name     = "sub"
                  type     = "string"
                  required = true
                }
                property {
                  name       = "groups"
                  type       = "array"
                  required   = true
                  items_json = jsonencode({ type = "string" })
                }
              }
              property {
                name        = "outcome"
                type        = "string"
                description = "finalize 전용: PUBLISHED | BLOCKED | REJECTED"
              }
            }
          }
        }
      }
    }
  }
}

# ---------- 오케스트레이터 Runtime ----------
resource "aws_ecr_repository" "orchestrator" {
  name                 = "${var.n.prefix}-ecr-pipeline${var.n.suffix}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.n.suffix != ""
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

resource "aws_iam_role" "runtime" {
  name = "${var.n.prefix}-role-rt-pipeline${var.n.suffix}"
  # 문서 원본을 읽지 않고 단계 Tool 만 호출 → 모델 호출 Role 로 분류 (quarantine 원본 등급 읽기 거부)
  tags = { "hanaeum-model-caller" = "true" }
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
      { Sid = "PipelineGatewayOnly", Effect = "Allow", Action = ["bedrock-agentcore:InvokeGateway"], Resource = aws_bedrockagentcore_gateway.pipeline.gateway_arn },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"], Resource = var.tables["documents"].arn },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"], Resource = var.tables["workflows"].arn },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = var.kms_key_arn },
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = aws_ecr_repository.orchestrator.arn },
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:DescribeLogGroups"], Resource = "arn:aws:logs:${local.region}:${local.acct}:log-group:/aws/bedrock-agentcore/*" },
      { Effect = "Allow", Action = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets", "cloudwatch:PutMetricData"], Resource = "*" },
      { Effect = "Allow", Action = ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT", "bedrock-agentcore:GetWorkloadAccessTokenForUserId"], Resource = "*" },
    ]
  })
}

resource "aws_bedrockagentcore_agent_runtime" "pipeline" {
  count              = var.runtime_image == null ? 0 : 1
  agent_runtime_name = local.runtime_name
  description        = "문서 처리 오케스트레이터 (Strands Graph, 단계 순서 고정)"
  role_arn           = aws_iam_role.runtime.arn
  agent_runtime_artifact {
    container_configuration { container_uri = var.runtime_image }
  }
  network_configuration { network_mode = "PUBLIC" }
  environment_variables = merge(var.runtime_env, {
    PIPELINE_GATEWAY_URL = aws_bedrockagentcore_gateway.pipeline.gateway_url
    TABLE_DOCUMENTS      = var.tables["documents"].name
    TABLE_WORKFLOWS      = var.tables["workflows"].name
  })
}

output "gateway_id" { value = aws_bedrockagentcore_gateway.pipeline.gateway_id }
output "gateway_url" { value = aws_bedrockagentcore_gateway.pipeline.gateway_url }
output "gateway_arn" { value = aws_bedrockagentcore_gateway.pipeline.gateway_arn }
output "runtime_role_arn" { value = aws_iam_role.runtime.arn }
output "ecr_repository_url" { value = aws_ecr_repository.orchestrator.repository_url }
output "runtime_name" { value = local.runtime_name }
output "runtime_arn" { value = try(aws_bedrockagentcore_agent_runtime.pipeline[0].agent_runtime_arn, null) }
# Runtime 생성 전에도 쓸 수 있는 ARN 패턴 (type-detection·승인 API 의 InvokeAgentRuntime 권한)
output "runtime_arn_pattern" { value = "arn:aws:bedrock-agentcore:${local.region}:${local.acct}:runtime/${local.runtime_name}-*" }
