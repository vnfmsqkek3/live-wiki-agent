# AgentCore Memory (사용자 결정 11/16, 요청기록 let522mj_to_team_AgentCore-Memory도입).
# 범위: 사용자 Agent(가이드·검색 대화)만. 파이프라인 오케스트레이터는 쓰지 않음(상태는 DynamoDB).
#   단기: 세션 대화 이벤트 (actorId = Cognito sub, sessionId = 화면 대화 ID), 30일 만료, 팀 CMK
#   장기: summary 전략 1개, 네임스페이스 /users/{actorId}/ (사용자 간 공유 금지, dhxorb96 코드가 이 경로로 Retrieve)
# 저장 전 PII 검사·꺼낸 근거 재검증은 사용자 Agent(dhxorb96) 책임.
variable "n" { type = object({ prefix = string, suffix = string }) }
variable "kms_key_arn" { type = string }
variable "event_expiry_days" {
  type    = number
  default = 30
}

locals { name = replace("${var.n.prefix}_mem_agent${var.n.suffix}", "-", "_") } # 이름에 하이픈 불가

resource "aws_bedrockagentcore_memory" "agent" {
  name                  = local.name
  description           = "사용자 Agent 대화 메모리 (마스킹된 텍스트만 저장)"
  event_expiry_duration = var.event_expiry_days
  encryption_key_arn    = var.kms_key_arn
}

resource "aws_bedrockagentcore_memory_strategy" "summary" {
  memory_id           = aws_bedrockagentcore_memory.agent.id
  name                = "session_summary"
  type                = "SUMMARIZATION"
  namespace_templates = ["/users/{actorId}/"]
}

# 사용자 Agent Runtime Role 용 최소 권한 (dhxorb96 9c0578d: 대화 저장·조회)
resource "aws_iam_policy" "agent_memory" {
  name        = "${var.n.prefix}-policy-memory-agent${var.n.suffix}"
  description = "사용자 Agent 의 AgentCore Memory 최소 권한"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock-agentcore:CreateEvent", "bedrock-agentcore:ListEvents", "bedrock-agentcore:RetrieveMemoryRecords"]
      Resource = aws_bedrockagentcore_memory.agent.arn
    }]
  })
}

# API(ECS) Role 용: DELETE /v1/me/memory (본인 sub 만은 API 코드가 강제). 장기 요약까지 지우도록 MemoryRecord 삭제 포함
resource "aws_iam_policy" "api_memory" {
  name        = "${var.n.prefix}-policy-memory-api${var.n.suffix}"
  description = "API 의 AgentCore Memory 삭제 경로 권한"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "bedrock-agentcore:ListSessions", "bedrock-agentcore:ListEvents", "bedrock-agentcore:DeleteEvent",
        "bedrock-agentcore:ListMemoryRecords", "bedrock-agentcore:DeleteMemoryRecord",
      ]
      Resource = aws_bedrockagentcore_memory.agent.arn
    }]
  })
}

output "memory_id" { value = aws_bedrockagentcore_memory.agent.id }
output "memory_arn" { value = aws_bedrockagentcore_memory.agent.arn }
output "agent_policy_arn" { value = aws_iam_policy.agent_memory.arn }
output "api_policy_arn" { value = aws_iam_policy.api_memory.arn }
