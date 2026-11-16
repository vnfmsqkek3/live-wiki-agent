# Bedrock Guardrails (docs/01 4.3, docs/03 ⑤, 13항 4): 정규식이 못 잡는 문맥 PII(이름·주소 등) 마스킹만.
# 다른 정책(주제·욕설·프롬프트 공격)은 끈다: 차단되면 출력이 차단 문구로 바뀌어 본문을 잃는다. 지시문 검사는 InjectionScan
# PiiScan(dhxorb96 applyGuardrail)이 ApplyGuardrail 로 호출 (모델 추론 아님). 출력 text 는 ANONYMIZE 된 본문.
resource "aws_bedrock_guardrail" "pii" {
  name                      = "${local.n.prefix}-guardrail-pii${local.n.suffix}"
  description               = "문서·질의 PII 마스킹 (SYNTHETIC 데이터)"
  blocked_input_messaging   = "개인정보 또는 허용되지 않은 지시가 포함되어 처리할 수 없습니다."
  blocked_outputs_messaging = "개인정보 또는 허용되지 않은 내용이 포함되어 표시할 수 없습니다."
  # ponytail: AWS 관리 키. CMK 는 키 정책에 bedrock 서비스 권한 추가 후

  sensitive_information_policy_config {
    dynamic "pii_entities_config" {
      for_each = toset(["NAME", "ADDRESS", "EMAIL", "PHONE", "AGE", "USERNAME", "PASSWORD", "CREDIT_DEBIT_CARD_NUMBER", "CREDIT_DEBIT_CARD_CVV", "CREDIT_DEBIT_CARD_EXPIRY", "PIN", "IP_ADDRESS", "LICENSE_PLATE", "AWS_ACCESS_KEY", "AWS_SECRET_KEY"])
      content {
        type   = pii_entities_config.value
        action = "ANONYMIZE"
      }
    }
    # 국내 식별번호 (정규식 단계와 이중 방어)
    regexes_config {
      name        = "KR_RRN"
      description = "주민등록번호"
      pattern     = "\\d{6}-?[1-4]\\d{6}"
      action      = "ANONYMIZE"
    }
    regexes_config {
      name        = "KR_ACCOUNT"
      description = "계좌번호 형식"
      pattern     = "\\d{3,6}-\\d{2,6}-\\d{2,6}(-\\d{1,3})?"
      action      = "ANONYMIZE"
    }
  }
}

resource "aws_bedrock_guardrail_version" "pii" {
  guardrail_arn = aws_bedrock_guardrail.pii.guardrail_arn
  description   = "PiiScan·질의 검사 고정 버전"
  lifecycle { replace_triggered_by = [aws_bedrock_guardrail.pii] }
}
