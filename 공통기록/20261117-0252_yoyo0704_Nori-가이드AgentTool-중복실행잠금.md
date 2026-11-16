# 공유 dev: Nori 한국어 분석기·가이드 Agent Tool 선택·중복 실행 잠금

| 항목 | 내용 |
|---|---|
| 상태 | 완료 (02:51 KST) |
| 커밋 | dhxorb96·웹·agents `8c0204a`, let522mj `7646838`, yoyo0704 `2443244` (dev·prod 설정 동일) |
| Nori | AOSS Korean (Nori) 기본 지원 확인. 인덱스 `hanaeum-kb-wiki-0b7ae830`(이름 = 매핑 해시), KB `U5XVDUWYLS` 교체, legal 19·knowledge 2 재색인 실패 0 |
| 가이드 Agent | 첫 검색 고정 + Tool 선택(허용 12종). 배포본 E2E "제12조 개정 전후·현행": get_official_policy·get_clause·compare_versions, 15초, 출처 제12조제1항(2026-11-01), dropped 0 |
| 중복 실행 | 업로드 1건 2회 실행 버그 → 오케스트레이터 `LOCK#{phase}` 조건부 쓰기 (91c4f29), smoke PASS |
| 파일 삭제 | finalize·freshness-sweep 에 quarantine 버전 삭제 권한 (반려·차단 원본·work 즉시, masked 7일) |
| prod | envs/prod 커밋 ref 지정, plan 389 add 오류 0. apply 는 사용자 결정 대기 |
| 아키텍처 | `hanaeum-terraform/docs/prod-architecture.drawio`·`.png` |
