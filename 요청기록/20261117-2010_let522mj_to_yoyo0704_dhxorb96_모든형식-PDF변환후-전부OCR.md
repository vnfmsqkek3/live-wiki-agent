# let522mj → yoyo0704, dhxorb96: 모든 형식을 PDF로 변환한 뒤 전부 OCR (사용자 결정 11/17)

상태: OPEN

## 사용자 결정 (원문)
- "업로드후 절차를 수정해줘. pdf 및 xml에서 글자추출하지말고, 무조건 ocr을 통해서 글자를 추출할수있도록 해줘"
- "pdf도 글자가아니라 사진일수있어 … 무조건 ocr로 처리가 되어야되지 않나?"
- "차라리 모든 확장자들을 pdf 변환먼저 한다음에 진행하면 될것같아"
- (megazone-idp 참고 후) 숨은 글자 비교는 하지 않음 ("굳이 숨은글자를 찾을필요있을까?" → 동의), CPU OCR은 지금 하지 않음, "진행하고 다시 테스트하고 문서에 반영해줘"

## 근거 (dev 실측 11/17, let522mj)
| 문서 | 결과 |
|---|---|
| 글자를 사진으로 만든 PDF | chars<50 → OCR, 신뢰도 0.95, 전부 인식 |
| 디지털 글자 + 글자 사진 PDF (Chrome·Apple SD Gothic Neo) | 디지털 글자가 깨짐(broken>0.2) → OCR, 0.97, 사진 속 글자까지 인식 |
| 지금 구조의 빈틈 | 디지털 글자가 "깨진 문자 없이 다른 글자로" 바뀐 경우·섞인 쪽의 사진 속 글자·숨긴 글자(흰 글씨)는 텍스트 레이어 기준으로는 못 잡음 |
| OCR 오인식 | 띄어쓰기 누락("자동화기기가현금을지급하지않으면"), ①→1(restoreCircled로 보정 중) |

## 새 절차 (확정 11/17)
| 순서 | 단계 | 담당 | 내용 |
|---|---|---|---|
| 1 | MalwareCheck | yoyo0704 | 그대로 (원본) |
| 2 | FileStructureCheck | 그대로 | 원본 파일 기준 (PNG 숨은 청크 등은 변환 전에만 보임) |
| **2.5** | **ConvertToPdf (신규)** | **yoyo0704** | 원본 → `{doc}/work/document.pdf`. PDF: 그대로 복사. PNG·JPG: 이미지 1장 = 1쪽. DOCX: LibreOffice headless (megazone-idp format-parser와 같은 컨테이너 Lambda: libreoffice-writer + fonts-noto-cjk·fonts-nanum, 제한 600초). HWPX: H2Orestart 확장으로 변환 시험 통과 시 포함, 미통과면 지금 방식 유지. **TXT·MD는 변환하지 않음**(이미지가 없어 OCR 대상 없음). 실패하면 BLOCKED + 사람이 읽을 수 있는 사유 |
| 3a | TextLayerExtract | let522mj | PDF·이미지·DOCX(·HWPX)는 **글자를 추출하지 않고** 쪽 수만, 모든 쪽 needs_ocr=true. TXT·MD만 글자를 그대로 읽음 |
| 3b | PageRender | yoyo0704 | `document.pdf`(없으면 원본 PDF)의 **모든 쪽** 렌더링 (reason `all`). DOCX·HWPX 그림 합성(composeFigures)은 불필요해짐 |
| 4 | OcrIfNeeded | yoyo0704 | **모든 쪽** PaddleOCR (지금 GPU 구성 그대로. CPU OCR은 전환 후 쪽당 처리 시간·업무 시간 외 첫 업로드 대기를 재 보고 느릴 때만 검토) |
| 5 | SegmentBuild | let522mj | 본문은 OCR만. 숨은 글자 비교는 하지 않음 (OCR 본문에는 눈에 안 보이는 글자가 처음부터 들어오지 않음) |
| 6~ | 이후 | 그대로 | 지시문 검사는 OCR 본문 대상 |
| 오케스트레이터·화면 | | dhxorb96 | `convert_to_pdf` 노드를 file_structure_check 뒤, text_layer_extract·page_render 앞에. 진행 표시 '문서 변환'. 미리보기는 `document.pdf` 사용 검토 |

## 배포 순서
let522mj의 TextLayerExtract 변경과 yoyo0704의 PageRender(모든 쪽) 변경은 **같이 배포**해야 합니다. 한쪽만 배포되면 SegmentBuild가 "OCR 결과에 page N 없음"으로 멈춥니다. DOCX는 ConvertToPdf가 없으면 let522mj 쪽이 지금 방식(XML 글자)으로 동작합니다.

## 유지할 것
- Trusted Registry 대조는 **원본 바이트 해시** 그대로 (변환 PDF 해시는 매번 달라짐)
- 호환: DOCX·HWPX는 `document.pdf`가 없으면 지금 방식(XML 글자)으로 동작

## 완료 후 재측정 (let522mj)
규정 19건 게시·인용 문구, 노하우 6건, 위조 4·공격 5 차단, 영향 탐지 5/5, 검색 실측. 사진 PDF·섞인 PDF(디지털 글자 + 글자 사진) 샘플 추가, 쪽당 OCR 시간

## dhxorb96 처리 (11/17)
- 오케스트레이터 `convert_to_pdf` 노드: file_structure_check → convert_to_pdf → (text_layer_extract ∥ page_render). 동기 호출(callTool 900초, Gateway 15분). 변환 BLOCKED면 뒤 단계 건너뜀(테스트). 진행 표시 '문서 변환'. 8d25284.
- 미리보기: 쪽 이미지는 PageRender가 document.pdf로 만든 masked/pages를 이미 사용. '원본 다운로드'는 Registry 해시 대상인 원본 그대로 유지(변경 없음).
- dev 업로드 QA(PDF·DOCX·PNG): 세 문서 모두 ConvertToPdf OK·게시까지 진행. 첫 OCR GPU 콜드 스타트 10분 47초 → qa-flow 대기 15분(67dd469). OCR 표 행·열 뒤집힘 발견 → yoyo0704 6b52ef3.
