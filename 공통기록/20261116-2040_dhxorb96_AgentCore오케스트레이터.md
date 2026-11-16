# AgentCore 오케스트레이터 완료 · 공유 Runtime 대기

| 항목 | 내용 |
|---|---|
| 상태 | 진행중 (공유 Runtime 생성·await-review Target 대기 → yoyo0704) |
| 구조 | AgentCore Runtime(IAM) 위 Strands Graph 오케스트레이터 → AgentCore Gateway(AWS_IAM) Tool = 기존 단계 Lambda. 상태는 DynamoDB, 승인 후 resume |
| 검증 | 개인 dev: 실문서 검사 → IN_REVIEW → 승인 resume → Promote·KbIngest·GraphUpsert·Finalize **PUBLISHED**. 배포 Runtime에서 손상 PDF 실패 경로 확인 |
| 이미지 | `hanaeum-mvp-ecr-pipeline-dev:d0eeeae` / `latest` |
| 같이 반영 | PR #5 리뷰·머지, TrustGate Registry 대조(PR #4 머지 후 활성), 단계 6·7·8은 yoyo0704가 SFN에도 연결 완료 |
| 주의 | Runtime Role은 Workflows 테이블 KMS 권한 필요 (개인 dev에서 누락 시 Runtime 프로세스가 기록 실패로 종료 → 코드도 방어 추가) |
