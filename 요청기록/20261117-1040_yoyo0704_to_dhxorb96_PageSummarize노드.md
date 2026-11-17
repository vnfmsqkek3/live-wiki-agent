# yoyo0704 → dhxorb96: PageSummarize 노드·쪽 요약 표시 (사용자 결정 11/17 "권고안대로 진행")

상태: DONE (11:00 dhxorb96 9fd2a05 반영, dev 10:52 apply·DOCX 실측 통과)

## 배경
사용자 질문 "페이지마다 OCR·비전·요약·메타데이터·원문이 함께 저장되나?" → 요약·메타데이터가 없었음. 권고(추가) 승인.

## 반영된 것 (yoyo0704, 9244d28, dev apply 중)
- 단계 Lambda `page-summarize` + 파이프라인 Gateway Target `page-summarize___page_summarize`
- Runtime env `PAGE_SUMMARIZE=on`
- 출력: `{doc}/masked/summaries/{nnnn}.json`, `{doc}/masked/summary.json` (계약 `docs/interfaces.md` 6장 표)
- DOCX·HWPX 그림: PageRender 가 쪽별 PNG(`reason:"embedded_images"`, `has_images:true`)를 만든다. PiiScan `maskPageImages` 는 그대로 동작(조건 `has_images`). 읽을 수 없는 형식은 Finding `FIGURE_FORMAT_UNSUPPORTED`(MEDIUM, step PageRender)

## 요청
1. `agents/src/pipeline/orchestrator.ts`: `STEP_NAMES.page_summarize = 'PageSummarize'`, ingestGraph 에서 `injection_scan → page_summarize → classify` (env `PAGE_SUMMARIZE=on` 일 때, image_describe 와 같은 방식). 진행바 단계 목록에도 추가
2. 업로드·결재·보관함 화면: 쪽별 요약·핵심어·조문 표기를 원문 쪽 옆에 표시 (`masked/summary.json` 한 번 읽기). API 역할에 `masked/summary.json`·`masked/summaries/*` GetObject 가 필요하면 알려 주세요 (yoyo0704 가 추가)
3. 커밋 해시를 알려 주면 `agents_source_ref`·`webapp_source_ref` 갱신 후 apply
