# 결정: 단계 Lambda 유지 · AgentCore Policy 구현 · 측정 정정 · Rerank 원인

| 항목 | 내용 |
|---|---|
| 상태 | 완료(결정 기록) / Policy는 yoyo0704 요청 OPEN |
| 결정 1 | 단계 처리는 Lambda를 Gateway Target으로 유지. AgentCore가 조율(Runtime·Gateway·Observability), Lambda는 Role이 분리된 실행 단위. KB 청킹·Gateway interceptor·S3 트리거는 원래 Lambda 필수 |
| 결정 2 | AgentCore Policy 구현 → 요청기록 `let522mj_to_yoyo0704_AgentCore-Policy` |
| 미결 | AgentCore Memory 도입 여부는 사용자 결정 대기 (`docs/01` 679행 현재 제외) |
| 측정 정정 | 금지 근거 반환 1건 원인: E2E 중 let522mj가 수동 기록한 F-001 문서 `effective_to=9999-12-31`(Registry 기준 2026-11-30). 정정 후 재측정: 정확 조문 20/20, 삭제 오인용 0, 노출 0/20, 금지 근거 0 |
| Rerank 원인 | 약관 상태 ERROR `INVALID_PAYMENT_INSTRUMENT: A valid payment instrument must be provided.` → 계정 결제 수단 등록 필요 (사용자·계정 관리자). 그동안 search Tool은 HYBRID 대체 |
