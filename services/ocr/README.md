PaddleOCR SageMaker Async 컨테이너 (Python 예외, Owner yoyo0704). 출력 스키마 `docs/04` 2.1.

| 파일 | 내용 |
|---|---|
| `Dockerfile` | AWS DLC pytorch-inference 2.2.0 cu118 (SageMaker GPU) + paddlepaddle-gpu 3.3.1 (cu118) + paddleocr 3.7.0 + paddlex 3.7.2 |
| `serve.py` | `/ping`, `/invocations` (표준 라이브러리 HTTP 서버) |
| `convert.py` | PaddleOCR 결과 → 팀 표준 블록 (confidence 보존) |
| `test_convert.py` | `cd services/ocr && python3 -B -m unittest test_convert.py` |

빌드는 CodeBuild(amd64)가 한다: `hanaeum-terraform/modules/ocr`.


## PP-StructureV3 (11/17 사용자 결정: 표·레이아웃 분석, 모든 업로드에 항상)
- 출력은 하위 호환: `blocks` 줄 단위(confidence 보존) + 줄마다 레이아웃 `label`·표 안이면 `table_id`, `reading_order` 는 레이아웃 순서. 페이지 `tables[{table_id,bbox,html}]` 추가.
- 수식·차트·도장 인식, 방향·왜곡 보정은 끔. 쪽당 시간·GPU 메모리는 CloudWatch 로그 `page_sec`·`gpu_max_mb` (텍스트 없음).
