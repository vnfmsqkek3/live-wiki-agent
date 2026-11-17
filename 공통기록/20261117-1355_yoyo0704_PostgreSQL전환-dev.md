# dev 거버넌스 저장소 PostgreSQL 전환 완료 (사용자 결정 11/17)

| 항목 | 결과 |
|---|---|
| 대상 | documents·findings·approvals·feedback·drafts·audit_events → Aurora PostgreSQL 17.9 Serverless v2 (Data API) |
| 유지 | DynamoDB workflows·regulations. 옛 DynamoDB 거버넌스 테이블은 롤백용으로 남김 |
| 순서 | 세 사람 PG 코드 dev 반영(yoyo 2d53d78·dhxorb96 946b4b0/a10314f·let522mj 04b365f) → let522mj wipe(Neptune 156·S3 버전·마커 0·KB 재색인·workflows 0) → PG TRUNCATE → governance_store=postgres (13:43) |
| 검증 | smoke PASS 13:55 (문서 레코드 PG 에만, findings·summary 포함). 권한 실측: app 사용자 감사 UPDATE·DELETE·DDL 거부, 자기 승인·잘못된 상태 CHECK 거부 |
| 사고 | 첫 smoke 실패: yoyo0704 단계 Lambda ref 가 GOV_STORE 분기 전 커밋(0d69d1f) → 2d53d78 로 보정 |
| 설정 | Aurora min 0.5 ACU (dev 도: 자동 일시정지 재개 지연 수십 초), OCR 평일 08:30~19:00 KST 예열 |
| 다음 | let522mj 재업로드, dhxorb96 화면 QA, 통과 후 prod 동일 절차 |

- mock 없음. 통계·리포트 화면 보류(사용자 결정).
