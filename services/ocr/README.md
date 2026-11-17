PaddleOCR SageMaker Async 컨테이너 (Python 예외, Owner yoyo0704). 출력 스키마 `docs/04` 2.1.

| 파일 | 내용 |
|---|---|
| `Dockerfile` | AWS DLC pytorch-inference 2.2.0 cu118 (SageMaker GPU) + paddlepaddle-gpu 3.3.1 (cu118) + paddleocr 3.7.0 + paddlex 3.7.2 |
| `serve.py` | `/ping`, `/invocations` (표준 라이브러리 HTTP 서버) |
| `convert.py` | PaddleOCR 결과 → 팀 표준 블록 (confidence 보존) |
| `test_convert.py` | `cd services/ocr && python3 -B -m unittest test_convert.py` |

빌드는 CodeBuild(amd64)가 한다: `hanaeum-terraform/modules/ocr`.
