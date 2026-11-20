# AI엔지니어팀 (ai)

문서 처리 오케스트레이터, PII·Injection·분류·Trust Gate 판단, 검색·가이드 Agent, Guardrails 정책 내용, 모델·프롬프트를 책임진다.

| 항목 | 내용 |
|---|---|
| 소유 경로 | `agents/`, `packages/pii/`, `mcp/privacy-server/` |
| 필수 문서 | `docs/01` 5·9·10장, `docs/03` 5장, `docs/04` 1·3·4.3장, `docs/interfaces.md` 6·9장 |
| 14단계 | 6 PiiScan·마스킹, 7 InjectionScan, 8 Classify, 9 TrustGate, 오케스트레이터 |
| 하지 않는 것 | KB를 직접 호출하는 것. 검색은 AgentCore Gateway Tool로만 한다 |

## 규칙

- 모델에는 마스킹된 텍스트만 보낸다. 사용자 질의와 Tool 인자도 모델을 호출하기 전에 PII 검사를 한다.
- 모델 ID는 환경변수로만 받는다. 기본은 Sonnet 5.5·Haiku 5.5이고, Opus 5.5는 고위험 검토에만 쓴다.
- Classify는 `temperature 0`과 구조화 출력을 쓴다. 결과, confidence, rationale을 저장한다.

## 남은 일 (11/20~11/23, 착수 전에 실제 상태 확인)

- [ ] 노하우 검증: 조문 충돌·근거(K-002), 최신성(K-003), 조건부(K-004). 정량 4/5 이상
- [ ] Change Impact 수정 초안 생성 (자동 게시 금지, 사람 재승인)
- [ ] 가이드 Agent 답변 품질: 근거 인용 19/20, UNVERIFIED 오판 0 (정답은 데이터QA팀 제공)
- [ ] Guardrails 출력 검사 연결
- [ ] 파이프라인 정량: 정상 5 승인, 위조 5 차단, Injection 5 KB 유입 차단
- [ ] (P1) Opus 고위험 검토, Wiki Maintenance 초안 모델
