# Bedrock Guardrails (docs/01 4.3, docs/03 ⑤, 13항 4): 정규식이 못 잡는 문맥 PII(이름·주소 등) 마스킹만.
# 다른 정책(주제·욕설·프롬프트 공격)은 끈다: 차단되면 출력이 차단 문구로 바뀌어 본문을 잃는다. 지시문 검사는 InjectionScan
# PiiScan(dhxorb96 applyGuardrail)이 ApplyGuardrail(source OUTPUT — INPUT 은 마스킹 안 함, 실측)로 호출. 출력 text 는 ANONYMIZE 된 본문.
resource "aws_bedrock_guardrail" "pii" {
  name                      = "${local.n.prefix}-guardrail-pii${local.n.suffix}"
  description               = "문서·질의 PII 마스킹 (SYNTHETIC 데이터)"
  blocked_input_messaging   = "개인정보 또는 허용되지 않은 지시가 포함되어 처리할 수 없습니다."
  blocked_outputs_messaging = "개인정보 또는 허용되지 않은 내용이 포함되어 표시할 수 없습니다."
  # ponytail: AWS 관리 키. CMK 는 키 정책에 bedrock 서비스 권한 추가 후

  sensitive_information_policy_config {
    dynamic "pii_entities_config" {
      # 개인을 식별하는 값·비밀값만 (사용자 결정 11/17 "이름·나이는 PII 아님", 요청기록 20261117-0047). NAME·AGE·ADDRESS 제외
      # IP_ADDRESS·USERNAME 제외 (사용자 결정 11/17 21시): 장비 IP·제품명(SINDORICOH 등)을 가려 가이드 문서가 쓸모없어짐 (과천사옥 매뉴얼 실측)
      # EMAIL·PHONE 제외 (사용자 결정 11/17 22시: 가이드의 담당자 연락처·이메일을 안내할 수 있게)
      for_each = toset(["PASSWORD", "CREDIT_DEBIT_CARD_NUMBER", "CREDIT_DEBIT_CARD_CVV", "CREDIT_DEBIT_CARD_EXPIRY", "PIN", "LICENSE_PLATE", "AWS_ACCESS_KEY", "AWS_SECRET_KEY"])
      content {
        type   = pii_entities_config.value
        action = "ANONYMIZE"
      }
    }
    # 국내 식별번호·계좌는 규칙 단계(@hanaeum/pii: 주민번호 체크섬, 날짜 제외)만. Guardrail regex 는 시행일 등 날짜를 가려 뺌 (dhxorb96 실측 11/16)
  }
}

resource "aws_bedrock_guardrail_version" "pii" {
  guardrail_arn = aws_bedrock_guardrail.pii.guardrail_arn
  description   = "PiiScan·질의 검사 고정 버전"
  # 새 버전 생성 → Lambda env 갱신 → 옛 버전 삭제 (실행 중 단계가 삭제된 버전을 부르지 않게)
  lifecycle {
    replace_triggered_by  = [aws_bedrock_guardrail.pii]
    create_before_destroy = true
  }
}
