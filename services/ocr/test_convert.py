import unittest

from convert import normalize_table_html, to_page, to_structure_page


class ToPageTest(unittest.TestCase):
    def test_keeps_confidence_and_orders_top_to_bottom(self):
        res = {
            "rec_texts": ["② 둘째 항", "제12조(승인 기준) ① 첫째 항"],
            "rec_scores": [0.81, 0.97],
            "rec_boxes": [[10, 200, 500, 230], [10, 100, 600, 130]],
        }
        p = to_page(0, 2000, 2828, res)
        self.assertEqual([b["text"] for b in p["blocks"]], ["제12조(승인 기준) ① 첫째 항", "② 둘째 항"])
        self.assertEqual(p["blocks"][0]["confidence"], 0.97)
        self.assertEqual(p["blocks"][1]["block_id"], "p0-b1")
        self.assertEqual(p["source"], "ocr")

    def test_empty_page(self):
        self.assertEqual(to_page(3, 1, 1, {})["blocks"], [])


class StructureTest(unittest.TestCase):
    RES = {
        "overall_ocr_res": {
            "rec_texts": ["구분", "한도", "제12조(승인 기준)", "개인 5억", "① 첫째 항"],
            "rec_scores": [0.99, 0.98, 0.97, 0.95, 0.96],
            "rec_boxes": [[100, 500, 200, 530], [300, 500, 400, 530], [100, 100, 600, 130], [100, 560, 400, 590], [100, 200, 600, 230]],
        },
        "parsing_res_list": [
            {"block_label": "table", "block_bbox": [80, 480, 900, 620], "block_content": "<table><tr><td>구분</td><td>한도</td></tr></table>", "block_order": 3},
            {"block_label": "paragraph_title", "block_bbox": [80, 90, 900, 140], "block_content": "제12조(승인 기준)", "block_order": 1},
            {"block_label": "text", "block_bbox": [80, 190, 900, 240], "block_content": "① 첫째 항", "block_order": 2},
            {"block_label": "image", "block_bbox": [80, 700, 900, 1200], "block_content": "", "block_order": 4},
            {"block_label": "header_image", "block_bbox": [0, 0, 200, 60], "block_content": ""},
        ],
    }

    def test_lines_keep_confidence_get_label_and_layout_order(self):
        p = to_structure_page(0, 2000, 2828, self.RES)
        self.assertEqual([b["text"] for b in p["blocks"]], ["제12조(승인 기준)", "① 첫째 항", "구분", "한도", "개인 5억"])
        self.assertEqual([b["label"] for b in p["blocks"]], ["paragraph_title", "text", "table", "table", "table"])
        self.assertEqual(p["blocks"][0]["confidence"], 0.97)
        self.assertEqual({b["table_id"] for b in p["blocks"][2:]}, {"p0-t0"})
        self.assertIsNone(p["blocks"][0]["table_id"])
        self.assertEqual(p["tables"], [{"table_id": "p0-t0", "bbox": [80, 480, 900, 620], "html": "<table><tr><td>구분</td><td>한도</td></tr></table>"}])
        # 비전 대상은 사진 영역만 (표·글자·머리말 로고 제외)
        self.assertEqual(p["figures"], [{"label": "image", "bbox": [80, 700, 900, 1200]}])

    def test_table_html_falls_back_to_table_res_list(self):
        res = dict(self.RES, parsing_res_list=[dict(self.RES["parsing_res_list"][0], block_content="구분 한도")], table_res_list=[{"pred_html": "<table>x</table>"}])
        self.assertEqual(to_structure_page(1, 1, 1, res)["tables"][0]["html"], "<table>x</table>")

    def test_no_layout_falls_back_to_plain_ocr(self):
        p = to_structure_page(0, 1, 1, {"overall_ocr_res": self.RES["overall_ocr_res"]})
        self.assertEqual(p["blocks"][0]["label"], "paragraph")
        self.assertNotIn("tables", p)


class TableOrderTest(unittest.TestCase):
    # 11/17 dev 실측 재현: pred_html 이 행·열 모두 뒤집힘, cell_box_list 는 같은 (뒤집힌) 순서로 셀 좌표
    REVERSED = ('<table><tr><td colspan="3">한도 초과 시 기록</td></tr>'
                '<tr><td>지점장</td><td>1,000만원</td><td>VIP 창구</td></tr>'
                '<tr><td>승인자</td><td>1회 한도</td><td>구분</td></tr></table>')
    BOXES = [[430, 700, 1700, 740],
             [1531, 640, 1700, 680], [900, 640, 1100, 680], [430, 640, 600, 680],
             [1531, 575, 1700, 615], [900, 575, 1100, 615], [430, 575, 600, 615]]

    def test_reorders_by_coordinates_keeps_colspan(self):
        out = normalize_table_html(self.REVERSED, self.BOXES)
        self.assertEqual(out, '<table><tr><td>구분</td><td>1회 한도</td><td>승인자</td></tr>'
                              '<tr><td>VIP 창구</td><td>1,000만원</td><td>지점장</td></tr>'
                              '<tr><td colspan="3">한도 초과 시 기록</td></tr></table>')

    def test_boxes_in_natural_order_are_paired_by_ocr_text(self):
        boxes = list(reversed(self.BOXES))  # 좌표 목록은 정상 순서, HTML 만 뒤집힌 경우
        lines = [("구분", [440, 580, 500, 610]), ("1회 한도", [910, 580, 1000, 610]), ("승인자", [1540, 580, 1600, 610]),
                 ("VIP 창구", [440, 645, 560, 675]), ("1,000만원", [910, 645, 1050, 675]), ("지점장", [1540, 645, 1600, 675]),
                 ("한도 초과 시 기록", [440, 705, 900, 735])]
        self.assertEqual(normalize_table_html(self.REVERSED, boxes, lines), normalize_table_html(self.REVERSED, self.BOXES))

    def test_cell_text_comes_from_ocr_lines_not_garbled_table_text(self):
        garbled = self.REVERSED.replace("승인자", "눔후어후").replace("구분", "플Y")
        lines = [("구분", [440, 580, 500, 610]), ("1회 한도", [910, 580, 1000, 610]), ("승인자", [1540, 580, 1600, 610]),
                 ("VIP 창구", [440, 645, 560, 675]), ("1,000만원", [910, 645, 1050, 675]), ("지점장", [1540, 645, 1600, 675]),
                 ("한도 초과 시 기록", [440, 705, 900, 735])]
        out = normalize_table_html(garbled, self.BOXES, lines)
        self.assertIn("<td>구분</td><td>1회 한도</td><td>승인자</td>", out)
        self.assertNotIn("눔후어후", out)

    def test_count_mismatch_keeps_original(self):
        self.assertEqual(normalize_table_html(self.REVERSED, self.BOXES[:2]), self.REVERSED)


if __name__ == "__main__":
    unittest.main()
