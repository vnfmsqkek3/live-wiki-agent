# 공유 dev 문서 처리 AgentCore 전환 완료 · 승인 경로까지 검증

| 항목 | 내용 |
|---|---|
| 상태 | 완료 |
| 구조 | 업로드 → type-detection → **AgentCore Runtime `hanaeum_mvp_rt_pipeline_dev`**(Strands Graph 오케스트레이터) → **AgentCore Gateway** Tool(단계 Lambda) → IN_REVIEW → 승인 API → **InvokeAgentRuntime(resume)** → 게시 단계 |
| 검증 | `doc_01M7J3JDCF85X2T0AENC1F14K8`: 11단계 OK → IN_REVIEW → 승인 → Promote·KbIngest·GraphUpsert·Finalize → PUBLISHED, EXECUTION SUCCEEDED, 승인 USED, 일반 사용자 404→200. SFN 실행 없음 |
| 함께 반영 | PR #4 병합 + TrustGate Registry 대조 활성 (F-001 해시 → VERIFIED·law_id 기록) |
| 검증 도구 | `node agents/scripts/pipeline.ts start\|resume\|status <doc_id>` (AgentCore Runtime 직접 호출 + 단계 기록) |
| 남은 것 | SFN 리소스 폐기(yoyo0704), 오케스트레이터 OTel(ADOT) Trace(dhxorb96), SFN 잔여 실행 1건 정리 |
