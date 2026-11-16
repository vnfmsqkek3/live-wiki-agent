# AgentCore Policy (사용자 결정 11/16, 요청기록 let522mj_to_yoyo0704_AgentCore-Policy)
# 파이프라인 Gateway: 기본 거부(Cedar default deny) + 오케스트레이터 Role 의 단계 Tool 만 허용. ENFORCE.
# Cedar 문법: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-understanding-cedar.html
#   AWS_IAM Gateway 의 principal = AgentCore::IamEntity, principal.id = 호출자 IAM ARN (assumed-role)
#   action in AgentCore::Action::"<Target 이름>" 으로 Target 의 Tool 전체 허용

resource "aws_bedrockagentcore_policy_engine" "pipeline" {
  name        = replace("${var.n.prefix}_pe_pipeline${var.n.suffix}", "-", "_")
  description = "문서 처리 파이프라인 Gateway 정책"
}

resource "aws_bedrockagentcore_policy" "orchestrator_only" {
  name             = "orchestrator_steps_only"
  description      = "오케스트레이터 Role 만 단계 Tool 호출 허용 (그 외 기본 거부)"
  policy_engine_id = aws_bedrockagentcore_policy_engine.pipeline.policy_engine_id
  validation_mode  = "FAIL_ON_ANY_FINDINGS"
  definition {
    cedar {
      statement = <<-CEDAR
        permit(
          principal is AgentCore::IamEntity,
          action in [${join(", ", [for t in keys(local.steps) : "AgentCore::Action::\"${replace(t, "_", "-")}\""])}],
          resource == AgentCore::Gateway::"${aws_bedrockagentcore_gateway.pipeline.gateway_arn}"
        ) when {
          principal.id like "arn:aws:sts::${local.acct}:assumed-role/${aws_iam_role.runtime.name}/*"
        };
      CEDAR
    }
  }
  # 정책은 엔진이 Gateway 에 연결된 뒤 Gateway Tool 스키마로 검증된다
  depends_on = [aws_bedrockagentcore_gateway_target.step]
}
