# let522mj → dhxorb96 : TrustGate에 Registry 대조 연결 (E2E 차단 요인)

| 항목 | 내용 |
|---|---|
| 상태 | DONE (코드·배포 완료, PR #4 머지 후 활성) |
| 대상 기능 | `apps/api/src/lambdas.ts` `makeTrustGate` (현재 `trustGate({ doc: d })`, "11/19 let522mj Registry" 주석) |
| 요청 내용 | 1. `@hanaeum/regulation-server`의 `registryMatch(new DynamoClauseStore(TABLE_REGULATIONS), d.content_hash, maskedText)` 결과 `{registry, claimed}`를 그대로 `trustGate({ doc, claimed, registry })`에 넘겨 달라 (형태는 `trust-gate.ts` RegistryEntry·claimed와 같음. `registry.clauses` 키는 `ARTICLE:12/PARAGRAPH:1` 같은 경로)<br>2. VERIFIED(해시 일치)면 Documents에 `law_id`·`law_name`·`revision_id`·`effective_from`·`effective_to`(registry 값, YYYY-MM-DD)를 기록. Promote는 REGULATION이면 `law_id`·`revision_id`가 없을 때 게시를 거부함<br>3. TrustGate Role에 Regulations 테이블 `dynamodb:Query` 필요 (pk `REGHASH#…`, `LAW#…`) — Terraform `team_lambdas.tf` trust-gate statements는 yoyo0704 몫 (cc yoyo0704) |
| 기준 미달 근거 | 공유 dev E2E(`doc_01M7HZN9RMEB7SF6HJQ95VQ3X9`, F-001 PDF): 업로드 해시가 Registry PDF 기준본과 정확히 같은데 TrustGate가 `REGISTRY_NOT_FOUND`로 REVIEW_REQUIRED, `law_id` 없음 → Promote에서 `REGULATION은 law_id·revision_id 필수`로 실패 |
| 확인 방법 | `registryMatch`는 PR #4 (main 머지 후 사용 가능). 실 테이블에서 F-001 PDF 해시 → `SYN-LOAN-001@2026-11-01` 조문 22개 반환 확인. F-003(위조)은 머리말로 주장 개정본을 찾고 조문 차이가 나옴(테스트) |
| 처리 결과 | (dhxorb96, 20:40) 1·2·3 반영(PR #2 `a89d95e`, `apps/api/src/lambdas.ts` makeTrustGate·`handlers.ts`): 해시만 먼저 대조 → 일치면 VERIFIED + Documents에 `law_id·law_name·revision_id·effective_from·effective_to·registry_doc_no` 기록. 불일치면 **REGULATION 분류일 때만** 마스킹 본문으로 주장 개정본 대조(노하우 머리말의 규정명 언급 오인 방지). sha256 표기 차이 무시. TrustGate Role에 Regulations Query 추가, `hanaeum-mvp-lambda-trust-gate-dhxorb96` env `TABLE_REGULATIONS` 배포. **`registryMatch`는 PR #4에만 있어 머지 전엔 대조 생략** → PR #4 ci-app 통과·머지되면 즉시 재빌드·배포한다 (PR #4 코멘트) |
