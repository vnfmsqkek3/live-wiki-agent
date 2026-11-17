"""SageMaker Async Inference 서버. 요청: {"doc_id","bucket","pages":[{"page_index","key"}]}
이미지는 quarantine 버킷 {doc_id}/work/pages/ 에서 읽는다. 응답은 SageMaker 가 S3 출력 위치에 저장한다.
로그에 OCR 텍스트를 남기지 않는다 (원본 등급)."""
import json
import os
import queue
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import boto3

from convert import to_structure_page

MODEL = {"ocr": None, "error": None}
# 10쪽 청크 병렬 처리 (사용자 결정 11/17). 모델 인스턴스를 WORKERS 개 올려 두고 요청마다 하나씩 빌려 쓴다.
# 실측(11/17): 쪽당 평균 1.19초, GPU 최대 2.6GB/인스턴스 → T4 16GB 에 3개. SageMaker max_concurrent_invocations_per_instance 와 같게
WORKERS = int(os.environ.get("OCR_WORKERS", "3"))
POOL: "queue.Queue" = queue.Queue()
s3 = boto3.client("s3")


def load():
    try:
        from paddleocr import PPStructureV3  # 무거운 import 는 백그라운드에서

        import paddle

        # 장치는 paddle 이 고른다 (GPU 가 보이면 GPU). 참고 구현처럼 시작 시 인식 결과를 남겨 진단에 쓴다
        print("paddle", paddle.__version__, "cuda_compiled", paddle.is_compiled_with_cuda(),
              "gpu_count", paddle.device.cuda.device_count(), "device", paddle.device.get_device(), flush=True)
        # 표·레이아웃 분석 PP-StructureV3 (사용자 결정 11/17, 모든 업로드에 항상). 인식은 lang=korean → korean mobile rec 그대로.
        # 수식·차트·도장 인식은 끔(속도, 은행 문서에 불필요). 방향·왜곡 보정도 끔(렌더링 PDF 라 반듯함)
        def make():
            return PPStructureV3(
            lang="korean",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            use_formula_recognition=False,
            use_chart_recognition=False,
            use_seal_recognition=False,
            use_table_recognition=True,
        )
        for _ in range(WORKERS):  # predictor 는 스레드 간 공유하지 않는다 (인스턴스당 1요청)
            POOL.put(make())
        MODEL["ocr"] = True
        print("model loaded", WORKERS, flush=True)
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
            t0 = time.time()
            model = POOL.get()
            try:
                r = model.predict(input=path)[0]
            finally:
                POOL.put(model)
            res = r.json.get("res", {}) if hasattr(r, "json") else r  # 참고 구현과 같은 결과 접근
            page = to_structure_page(p["page_index"], w, h, res)
            pages.append(page)
            # 실측용 (텍스트 없음): 쪽당 시간·줄 수·표 수·GPU 최대 메모리
            print(json.dumps({"page_sec": round(time.time() - t0, 2), "lines": len(page["blocks"]), "tables": len(page.get("tables", [])),
                              "gpu_max_mb": _gpu_mb()}), flush=True)
    return {"doc_id": req["doc_id"], "model": "paddleocr-PP-StructureV3-korean", "model_version": "paddleocr==3.7.0", "pages": pages}


def _gpu_mb():
    try:
        import paddle
        return round(paddle.device.cuda.max_memory_allocated() / 2**20)
    except Exception:  # noqa: BLE001
        return None


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
