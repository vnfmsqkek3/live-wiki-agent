# yoyo0704 → dhxorb96, let522mj: 거버넌스 저장소 PostgreSQL 전환 (사용자 결정 11/17)

상태: OPEN

## 사용자 결정
"저장소는 PostgreSQL 로 해주고, 통계 및 레포트 화면은 일단 보류" — 문서 승인 여부·메타데이터·검수 상태·피드백 등.

## 계약
`docs/interfaces.md` 10장 (yoyo0704 f5f0e91). 스키마 `hanaeum-terraform/db/migrations/001_init.sql`.
- 이전 대상: documents(META)·findings·drafts(DRAFT#)·approvals·feedback·audit_events
- 남는 DynamoDB: workflows, regulations

## yoyo0704 (완료·진행)
- Aurora PostgreSQL 17.9 Serverless v2 + Data API (dev 0 ACU 자동 일시정지, prod 0.5 ACU), app 사용자(audit 은 INSERT·SELECT 만), 마이그레이션 자동 적용 — dev apply 중
- `@hanaeum/db` (packages/db): `db().query/tx`, `toDocumentRow`/`fromDocumentRow`(DynamoDB 때와 같은 DocumentRecord 모양), `UPSERT_DOCUMENT_SQL`, `replaceStepFindings`, `pgCode`. **문서 행 변환은 반드시 이 함수로** (세 사람이 같은 모양)
- 모든 Lambda·API·오케스트레이터에 환경변수 `GOV_STORE`(지금 `dynamo`), `DB_CLUSTER_ARN`·`DB_SECRET_ARN`·`DB_NAME` 과 Data API 권한 배선 완료 (거버넌스 테이블을 쓰는 Lambda 만)
- 내 단계(MalwareCheck·PageRender·OcrIfNeeded·ImageDescribe·ExplainFindings·PurgeDocument) `GOV_STORE` 분기 완료
- 복사 스크립트 `hanaeum-terraform/scripts/db-copy-from-dynamo.mjs` (멱등)

## 요청 dhxorb96 (apps/api, mcp/approval-server, agents)
1. `apps/api/src/store-postgres.ts`: `Store` 인터페이스 그대로 구현. `server.ts`/`handlers.ts` 에서 `GOV_STORE==='postgres'` 면 사용
   - `listDocs()` 전체 조회 대신 `listDocsByOwner(sub)`·`listDocsByLifecycle([...])` 추가 권장 (보관함·결재함·노하우 점검 Scan 제거)
   - `decideApproval`: `UPDATE approvals SET … WHERE approval_id=:id AND status='PENDING' AND author_sub<>:ap AND s3_version_id=:v AND content_hash=:h RETURNING *` (0행 → 재조회로 사유 분류, 지금과 같은 오류 코드)
   - `consumeApproval`: `UPDATE … SET status='USED' WHERE status='APPROVED' RETURNING *`
   - `putFeedback`: `ON CONFLICT (doc_id,user_sub) DO UPDATE`, `audit`: INSERT 만
   - 단계 Lambda(`lambdas.ts`)의 findings 추가는 `replaceStepFindings` (tx 안)
2. ECS API 의존성에 `@aws-sdk/client-rds-data@3.1169.0`, `@hanaeum/db` (Dockerfile 에 packages/db 복사)
3. 오케스트레이터 Runtime 이 Documents 를 직접 읽거나 쓰면 같은 분기 (Runtime env·권한은 배선 완료)
4. mcp-approval 이 Documents·Approvals 를 쓰면 같은 분기

## 요청 let522mj (services/legal-etl, mcp/search-server, mcp/graph-server)
1. `services/legal-etl/src/store.ts` Records(getDocument·getApproval·문서 갱신) PostgreSQL 구현 + `GOV_STORE` 분기 (promote·kb-ingest·graph-upsert)
2. mcp-search: 검색 결과 재검증 BatchGet → `SELECT doc_id, lifecycle, authority_status, attrs->>'conditional', freshness, acl_groups, published_content_hash, attrs->>'effective_from', attrs->>'effective_to' FROM documents WHERE doc_id = ANY(ARRAY(SELECT jsonb_array_elements_text(:ids::jsonb)))`
3. mcp-graph: Documents 조회 같은 분기
4. Lambda 패키징에 `@hanaeum/db` 포함 (Lambda 런타임에 client-rds-data 는 내장)

## 전환 절차 (yoyo0704)
세 사람 커밋 dev 반영 → dev `governance_store="postgres"` apply → 복사 스크립트 → smoke·QA(업로드→승인→검색→삭제, 감사 기록) → prod 동일. DynamoDB 테이블은 롤백용으로 남김.

## 시험
dev Aurora 가 만들어지면 SSM `/hanaeum-mvp/dev/DB_*` 로 로컬에서 바로 붙을 수 있습니다 (Data API, VPC 불필요).
