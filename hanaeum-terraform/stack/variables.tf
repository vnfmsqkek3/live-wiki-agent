variable "env" { type = string }
variable "name_suffix" { type = string } # "" (prod) / "-dev" / "-{닉네임}"
variable "owner" { type = string }
variable "region" {
  type    = string
  default = "us-east-1"
}

# Bedrock inference profile ID. 계정에서 Claude 5.5 가 열리면 여기만 바꾼다 (트러블슈팅.md 2026-11-16).
variable "models" {
  type = map(string)
  default = {
    MODEL_HAIKU  = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    MODEL_SONNET = "us.anthropic.claude-sonnet-4-6"
    MODEL_OPUS   = "us.anthropic.claude-opus-4-6-v1"
    MODEL_EMBED  = "amazon.titan-embed-text-v2:0"
    MODEL_RERANK = "cohere.rerank-v3-5:0"
  }
}

# 단계 Lambda ARN. 비어 있으면 dev stub(mock) 을 쓴다. 단계 Owner 의 Lambda 가 배포되면 채운다 (docs/05 3장).
variable "step_functions" {
  type    = map(string)
  default = {}
}

# let522mj 의 KB Custom Transformation Lambda ARN (services/kb-chunker). null 이면 NONE 청킹만.
variable "kb_chunker_lambda_arn" {
  type    = string
  default = null
}

# KB Retrieve 를 직접 호출하는 Role (search MCP Tool 등). AOSS 데이터 접근 정책에 추가된다.
variable "kb_reader_role_arns" {
  type    = list(string)
  default = []
}

# quarantine presigned PUT 을 허용할 웹 출처. CloudFront 도메인이 생기면 추가
variable "web_origins" {
  type    = list(string)
  default = ["http://localhost:3000"]
}

# 문서 처리 오케스트레이터 이미지 태그 (dhxorb96 agents/, linux/arm64, ECR SSM PIPELINE_ECR_REPO). null 이면 Runtime 미생성
variable "pipeline_runtime_image_tag" {
  type    = string
  default = null
}

# 계정 단위 X-Ray → CloudWatch Logs (Transaction Search). 계정당 env 하나에서만 true
variable "enable_transaction_search" {
  type    = bool
  default = false
}

# 웹·API 이미지로 빌드할 커밋 (dhxorb96 apps/web·apps/api). null 이면 웹·API 미배포
variable "webapp_source_ref" {
  type    = string
  default = null
}

# Lambda 빌드 커밋 (공개 저장소). yoyo0704 는 필수 (workflows·auth-triggers), dhxorb96·let522mj 는 공유 이름 Lambda 를 배포할 때
variable "lambda_refs" { type = map(string) }
