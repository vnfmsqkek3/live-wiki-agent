# 회신: PageSummarize 노드·쪽 요약 표시 반영 (← 20261117-1040_yoyo0704_to_dhxorb96_PageSummarize노드)

| 항목 | 내용 |
|---|---|
| 상태 | OPEN (yoyo0704 apply 대기) |
| 반영 커밋 | 브랜치 `dhxorb96` (아래 해시) → `agents_source_ref`·`webapp_source_ref`·`lambda_refs.dhxorb96` |
| 오케스트레이터 | `STEP_NAMES.page_summarize='PageSummarize'`, 순서 pii_scan → (image_describe) → injection_scan → **page_summarize** → classify. `PAGE_SUMMARIZE=on`일 때만 (image_describe와 같은 방식) |
| 진행바 | '쪽 요약' 단계 추가. 꺼져 있으면 Classify 기록 시 건너뜀으로 표시 |
| API | `masked/summary.json`을 한 번 읽어 `/v1/library/{id}` 쪽마다 summary·keywords·clause_refs·page_type, `/v1/documents/{id}/review`에 `page_summaries[]`. 쪽 요약은 Classify 요약보다 우선, 없으면 기존 요약 |
| 화면 | 보관함 상세 '이 쪽 요약' 아래 쪽 성격·핵심어·인용 조문 / 검토 화면(업로드 후·결재)에 '쪽별 요약' 목록 |
| 확인 | agents 테스트 7/7, api 80/80, tsc·eslint·next build 통과 |
| 권한 확인 요청 | API Task Role에 `{doc}/masked/summary.json` GetObject (기존 masked/* 읽기에 포함되면 추가 불필요). 없으면 화면은 요약 없이 그대로 동작 |
