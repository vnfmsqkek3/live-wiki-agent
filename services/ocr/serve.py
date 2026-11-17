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
        base = dict(
            lang="korean",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            use_formula_recognition=False,
            use_chart_recognition=False,
            use_seal_recognition=False,
            use_table_recognition=True,
        )

        def make():
            # 표 방향 자동 판정 끔 (11/17 dev 실측: 반듯한 표를 180도로 판정해 행·열 뒤집힘 + 머리 행 글자 깨짐).
            # 렌더링 PDF·캡처라 표가 돌아가 있을 일이 없다. 이 버전에 옵션이 없으면 기본값으로
            try:
                return PPStructureV3(**base, use_table_orientation_classify=False)
            except Exception as e:  # noqa: BLE001  옵션 미지원(TypeError·ValueError 등)이면 기본값으로 — 모델 기동 실패로 엔드포인트가 죽지 않게
                print("use_table_orientation_classify unsupported", type(e).__name__, flush=True)
                return PPStructureV3(**base)
        for _ in range(WORKERS):  # predictor 는 스레드 간 공유하지 않는다 (인스턴스당 1요청)
            POOL.put(make())
        MODEL["merge"] = layout_merge_modes()
        print("layout_merge_bboxes_mode", MODEL["merge"], flush=True)
        MODEL["ocr"] = True
        print("model loaded", WORKERS, flush=True)
    except Exception as e:  # noqa: BLE001
        MODEL["error"] = repr(e)
        print("model load failed", MODEL["error"], flush=True)


# 레이아웃 겹친 상자 처리 (11/17 과천 매뉴얼 12쪽): 기본 "large"는 바깥 상자만 남겨, 화면 캡처 4장 + 단계 설명 글을
# 쪽 대부분을 덮는 image 상자 하나로 합친다 → 설명 글까지 그림 속 글자가 됨. 그림(image·chart)만 "small"(안쪽 상자 유지)로,
# 표·본문 등 나머지는 기본 "large" 그대로(표 상자가 안쪽 글 상자에 밀려 사라지지 않게). 클래스 번호는 모델 label_list 에서 찾는다
FIGURE_SMALL = ("image", "chart")


def _find_labels(o):
    """inference.yml 어디에 있든 label_list (PaddleX 버전마다 위치가 다름)"""
    if isinstance(o, dict):
        if isinstance(o.get("label_list"), list):
            return o["label_list"]
        for v in o.values():
            r = _find_labels(v)
            if r:
                return r
    return []


def layout_merge_modes():
    import glob

    import yaml

    for f in glob.glob(os.path.join(os.environ.get("PADDLE_PDX_CACHE_HOME", "/opt/models"), "**", "PP-DocLayout*", "inference.yml"), recursive=True):
        try:
            labels = _find_labels(yaml.safe_load(open(f)))
        except Exception:  # noqa: BLE001  못 읽으면 기본 동작
            continue
        if labels:
            modes = {i: ("small" if l in FIGURE_SMALL else "large") for i, l in enumerate(labels)}
            return modes if "small" in modes.values() else None
    return None


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
                kw = {"layout_merge_bboxes_mode": MODEL["merge"]} if MODEL.get("merge") else {}
                r = model.predict(input=path, **kw)[0]
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
