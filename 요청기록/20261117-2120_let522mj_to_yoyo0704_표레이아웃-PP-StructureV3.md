# let522mj → yoyo0704: OCR을 PP-StructureV3(표·레이아웃)로 (사용자 결정 11/17)

상태: OPEN

## 사용자 결정
- "표와 레이아웃 분석용 모델도 사용할수있게해줘" → 적용 방식 질문에 "모든 업로드에 항상" 선택
- 인식 모델은 그대로 mobile ("그럼 그냥 mobile로 해줘"). PP-StructureV3 안의 OCR도 lang=korean이면 같은 `PP-OCRv5_server_det` + `korean_PP-OCRv5_mobile_rec`

## 참고 구현
megazone-idp `packages/infra/src/functions/paddleocr/code/inference.py` `PPStructureV3Model`: `PPStructureV3(lang, use_doc_orientation_classify=False, use_doc_unwarping=False)`, 결과 `res.json["res"]["parsing_res_list"]`(block_label·block_content·block_bbox·block_order)

## 요청 (services/ocr, yoyo0704)
| 항목 | 내용 |
|---|---|
| 모델 | `PPStructureV3(lang="korean", use_doc_orientation_classify=False, use_doc_unwarping=False)`. 수식·차트·도장 인식은 끄기 권고(속도) |
| 출력 계약 (docs/04 2.1 확장, 하위 호환) | `blocks`는 **지금처럼 줄 단위** (`overall_ocr_res`의 rec_texts·rec_scores·rec_boxes, confidence 보존). 각 줄에 자기가 속한 레이아웃 영역의 `label`(doc_title·paragraph_title·text·table·figure 등)과, 표 안이면 `table_id`(예 `p0-t0`)를 채움. `reading_order`는 레이아웃 순서(block_order) 기준 |
| 신규 필드 | 페이지에 `tables: [{ table_id, bbox, html }]` (`table_res_list`의 pred_html 또는 parsing_res_list 표 블록 내용) |
| 실측 | 쪽당 처리 시간(현재 대비), T4 GPU 메모리 |

## let522mj (SegmentBuild)
- `table_id`가 있는 줄들은 본문에서 그 표의 `html`을 마크다운 표로 바꿔 한 번만 넣음 (칸 구조 유지). `tables`가 없으면 지금처럼 줄 나열 (하위 호환)
- 제목(label doc_title·paragraph_title)은 그대로 한 줄

## 완료 후 재측정
규정 19건 구조·본문 일치(현재 19/19, 324/328), 표가 든 노하우 샘플 검색·인용
