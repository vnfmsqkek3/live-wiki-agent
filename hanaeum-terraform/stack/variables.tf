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
