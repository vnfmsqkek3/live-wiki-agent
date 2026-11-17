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


# ---------- PP-StructureV3 (사용자 결정 11/17: 표·레이아웃 분석, 모든 업로드에 항상) ----------
# 결과 res: overall_ocr_res(rec_texts·rec_scores·rec_boxes) = 줄 단위 OCR, parsing_res_list(block_label·block_bbox·block_content·block_order)
# = 레이아웃 영역, table_res_list(pred_html) = 표 구조. 출력은 하위 호환: blocks 는 지금처럼 줄 단위(confidence 보존),
# 각 줄에 자기가 속한 영역의 label·(표 안이면) table_id, reading_order 는 영역 순서 기준. 페이지에 tables[{table_id,bbox,html}] 추가.
TABLE = "table"
# Sonnet 비전(ImageDescribe)이 볼 영역: 사진·그림·차트·도장. 표·글자는 OCR 이 맡는다 (사용자 결정 11/17: 비전 중복 분석 줄이기)
# 머리말·꼬리말 그림(로고)은 제외
FIGURE_LABELS = {"image", "figure", "chart", "seal"}


def _inside(box, region):
    """줄 상자 중심이 영역 안이면 True. box·region = [x0, y0, x1, y1]"""
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    return region[0] <= cx <= region[2] and region[1] <= cy <= region[3]


def to_structure_page(page_index, width, height, res):
    regions = list(res.get("parsing_res_list") or [])
    if not regions:  # 레이아웃 결과가 없으면 기존 OCR 변환 (하위 호환)
        return to_page(page_index, width, height, res.get("overall_ocr_res") or res)
    ocr = res.get("overall_ocr_res") or {}
    texts = list(ocr.get("rec_texts") or [])
    scores = list(ocr.get("rec_scores") or [])
    raw_boxes = ocr.get("rec_boxes") if ocr.get("rec_boxes") is not None else []
    boxes = [list(map(int, b)) for b in raw_boxes]

    # 영역 순서: block_order 가 없는 영역(머리말·꼬리말 등)은 뒤로, 같은 순서면 위→아래
    def order_key(i_r):
        i, r = i_r
        o = r.get("block_order")
        return (o is None, o if o is not None else 0, list(r.get("block_bbox") or [0, 0, 0, 0])[1], i)

    ordered = sorted(enumerate(regions), key=order_key)
    tables, figures, region_meta = [], [], {}
    html_by_order = [t.get("pred_html", "") for t in (res.get("table_res_list") or [])]
    for rank, (i, r) in enumerate(ordered):
        label = str(r.get("block_label") or "text")
        bbox = [int(v) for v in (r.get("block_bbox") or [0, 0, 0, 0])]
        table_id = None
        if label == TABLE:
            table_id = f"p{page_index}-t{len(tables)}"
            content = str(r.get("block_content") or "")
            html = content if content.lstrip().startswith("<") else (html_by_order[len(tables)] if len(tables) < len(html_by_order) else "")
            tables.append({"table_id": table_id, "bbox": bbox, "html": html})
        elif label in FIGURE_LABELS:
            figures.append({"label": label, "bbox": bbox})
        region_meta[i] = (rank, label, bbox, table_id)

    lines = []
    for text, score, box in zip(texts, scores, boxes):
        hit = next((region_meta[i] for i, r in ordered if _inside(box, region_meta[i][2])), None)
        rank, label, _, table_id = hit if hit else (len(ordered), "text", None, None)
        lines.append((rank, box[1] // 10, box[0], text, score, box, label, table_id))
    lines.sort(key=lambda t: (t[0], t[1], t[2]))  # 영역 순서 → 위→아래 → 왼→오른
    blocks = [
        {
            "block_id": f"p{page_index}-b{n}",
            "label": label,
            "text": text,
            "confidence": round(float(score), 4),
            "bbox": box,
            "reading_order": n,
            "table_id": table_id,
        }
        for n, (_, _, _, text, score, box, label, table_id) in enumerate(lines)
    ]
    return {"page_index": page_index, "width": width, "height": height, "source": "ocr", "blocks": blocks, "tables": tables, "figures": figures}
