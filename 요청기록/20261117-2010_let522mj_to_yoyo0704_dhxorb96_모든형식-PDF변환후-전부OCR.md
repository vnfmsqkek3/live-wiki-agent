# let522mj → yoyo0704, dhxorb96: 모든 형식을 PDF로 변환한 뒤 전부 OCR (사용자 결정 11/17)

상태: OPEN

## 사용자 결정 (원문)
- "업로드후 절차를 수정해줘. pdf 및 xml에서 글자추출하지말고, 무조건 ocr을 통해서 글자를 추출할수있도록 해줘"
- "pdf도 글자가아니라 사진일수있어 … 무조건 ocr로 처리가 되어야되지 않나?"
- "차라리 모든 확장자들을 pdf 변환먼저 한다음에 진행하면 될것같아"

## 근거 (dev 실측 11/17, let522mj)
| 문서 | 결과 |
|---|---|
| 글자를 사진으로 만든 PDF | chars<50 → OCR, 신뢰도 0.95, 전부 인식 |
| 디지털 글자 + 글자 사진 PDF (Chrome·Apple SD Gothic Neo) | 디지털 글자가 깨짐(broken>0.2) → OCR, 0.97, 사진 속 글자까지 인식 |
| 지금 구조의 빈틈 | 디지털 글자가 "깨진 문자 없이 다른 글자로" 바뀐 경우·섞인 쪽의 사진 속 글자·숨긴 글자(흰 글씨)는 텍스트 레이어 기준으로는 못 잡음 |
| OCR 오인식 | 띄어쓰기 누락("자동화기기가현금을지급하지않으면"), ①→1(restoreCircled로 보정 중) |

## 새 절차
| 순서 | 단계 | 담당 | 내용 |
|---|---|---|---|
| 1 | MalwareCheck | yoyo0704 | 그대로 (원본) |
| 2 | FileStructureCheck | 그대로 | 원본 파일 기준 (PNG 숨은 청크 등은 변환 전에만 보임) |
| **2.5** | **ConvertToPdf (신규)** | **yoyo0704** | 원본 → `{doc}/work/document.pdf`. PDF: 그대로 복사. PNG·JPG: 이미지 1장 = 1쪽. TXT·MD: Noto Sans KR로 렌더링. DOCX·HWPX: LibreOffice headless(HWPX는 H2Orestart 확장 필요, 품질 확인 필요). 실패하면 BLOCKED + 사람이 읽을 수 있는 사유 |
| 3a | TextLayerExtract | let522mj | `document.pdf`가 있으면 거기서 글자 정보 추출, **모든 쪽 needs_ocr=true**. 추출 글자는 본문이 아니라 숨은 글자 비교용 |
| 3b | PageRender | yoyo0704 | `document.pdf`의 **모든 쪽** 렌더링 (reason `all`). DOCX·HWPX 그림 합성(composeFigures)은 불필요해짐 |
| 4 | OcrIfNeeded | yoyo0704 | **모든 쪽** PaddleOCR. GPU 시간·비용 추산 부탁드립니다 |
| 5 | SegmentBuild | let522mj | 본문은 OCR만. 텍스트 레이어에만 있고 OCR에 없는 줄은 `HIDDEN_TEXT`(숨은 글자 의심) finding |
| 6~ | 이후 | 그대로 | |
| 오케스트레이터·화면 | | dhxorb96 | `convert_to_pdf` 노드를 file_structure_check 뒤, text_layer_extract·page_render 앞에. 진행 표시 '문서 변환'. 미리보기는 `document.pdf` 사용 검토 |

## 유지할 것
- Trusted Registry 대조는 **원본 바이트 해시** 그대로 (변환 PDF 해시는 매번 달라짐)
- 호환: let522mj 쪽은 `document.pdf`가 없으면 지금 방식으로 동작. ConvertToPdf가 배포되는 순간 전부 OCR로 전환

## 완료 후 재측정 (let522mj)
규정 19건 게시·인용 문구, 노하우 6건, 위조 4·공격 5 차단, 영향 탐지 5/5, 검색 실측. 사진 PDF·섞인 PDF·숨은 글자 PDF 샘플 추가
