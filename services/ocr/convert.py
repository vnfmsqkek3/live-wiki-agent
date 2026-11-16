"""PaddleOCR predict() 결과 1페이지 → 팀 표준 페이지 (docs/04 2.1). paddle 에 의존하지 않아 단독 테스트 가능."""


def to_page(page_index, width, height, res):
    texts = list(res.get("rec_texts") or [])
    scores = list(res.get("rec_scores") or [])
    boxes = [list(map(int, b)) for b in (res.get("rec_boxes") if res.get("rec_boxes") is not None else [])]
    items = sorted(zip(texts, scores, boxes), key=lambda t: (t[2][1] // 10, t[2][0]))  # 위→아래, 왼→오른
    blocks = [
        {
            "block_id": f"p{page_index}-b{i}",
            "label": "paragraph",  # 기본 OCR 파이프라인은 레이아웃 라벨이 없다
            "text": text,
            "confidence": round(float(score), 4),  # 반드시 보존 (저신뢰 페이지 판정)
            "bbox": box,
            "reading_order": i,
            "table_id": None,
        }
        for i, (text, score, box) in enumerate(items)
    ]
    return {"page_index": page_index, "width": width, "height": height, "source": "ocr", "blocks": blocks}
