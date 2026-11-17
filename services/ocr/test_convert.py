import unittest

from convert import to_page, to_structure_page


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

    def test_table_html_falls_back_to_table_res_list(self):
        res = dict(self.RES, parsing_res_list=[dict(self.RES["parsing_res_list"][0], block_content="구분 한도")], table_res_list=[{"pred_html": "<table>x</table>"}])
        self.assertEqual(to_structure_page(1, 1, 1, res)["tables"][0]["html"], "<table>x</table>")

    def test_no_layout_falls_back_to_plain_ocr(self):
        p = to_structure_page(0, 1, 1, {"overall_ocr_res": self.RES["overall_ocr_res"]})
        self.assertEqual(p["blocks"][0]["label"], "paragraph")
        self.assertNotIn("tables", p)


if __name__ == "__main__":
    unittest.main()
