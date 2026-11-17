"""SageMaker Async Inference 서버. 요청: {"doc_id","bucket","pages":[{"page_index","key"}]}
이미지는 quarantine 버킷 {doc_id}/work/pages/ 에서 읽는다. 응답은 SageMaker 가 S3 출력 위치에 저장한다.
로그에 OCR 텍스트를 남기지 않는다 (원본 등급)."""
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import boto3

from convert import to_page

MODEL = {"ocr": None, "error": None}
s3 = boto3.client("s3")


def load():
    try:
        from paddleocr import PaddleOCR  # 무거운 import 는 백그라운드에서

        import paddle

        # 장치는 paddle 이 고른다 (GPU 가 보이면 GPU). 참고 구현처럼 시작 시 인식 결과를 남겨 진단에 쓴다
        print("paddle", paddle.__version__, "cuda_compiled", paddle.is_compiled_with_cuda(),
              "gpu_count", paddle.device.cuda.device_count(), "device", paddle.device.get_device(), flush=True)
        MODEL["ocr"] = PaddleOCR(
            lang="korean",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
        print("model loaded", flush=True)
    except Exception as e:  # noqa: BLE001
        MODEL["error"] = repr(e)
        print("model load failed", MODEL["error"], flush=True)


def run(req):
    from PIL import Image

    pages = []
    with tempfile.TemporaryDirectory() as d:
        for p in req["pages"]:
            path = os.path.join(d, f"{p['page_index']:04d}.png")
            s3.download_file(req["bucket"], p["key"], path)
            with Image.open(path) as im:
                w, h = im.size
            r = MODEL["ocr"].predict(input=path)[0]
            res = r.json.get("res", {}) if hasattr(r, "json") else r  # 참고 구현과 같은 결과 접근
            pages.append(to_page(p["page_index"], w, h, res))
    return {"doc_id": req["doc_id"], "model": "paddleocr-korean-PP-OCRv5", "model_version": "paddleocr==3.7.0", "pages": pages}


class H(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # /ping
        if MODEL["ocr"] is not None:
            self._send(200, {"status": "ok"})
        else:
            self._send(500, {"status": "loading" if MODEL["error"] is None else "failed"})

    def do_POST(self):  # /invocations
        if self.path != "/invocations":
            return self._send(404, {"error": "not found"})
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        try:
            self._send(200, run(req))
        except Exception as e:  # noqa: BLE001  실패는 SageMaker 가 failure 경로에 기록
            # 예외 종류와 앞부분만 (S3 키·라이브러리 메시지. OCR 텍스트는 예외 메시지에 들어가지 않음)
            print("invocation failed", type(e).__name__, str(e)[:200], flush=True)
            self._send(500, {"error": type(e).__name__})

    def log_message(self, *_):  # 요청 로그 생략 (경로·본문 비노출)
        pass


if __name__ == "__main__":
    threading.Thread(target=load, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8080), H).serve_forever()
