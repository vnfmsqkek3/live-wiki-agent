import unittest

from convert import to_page


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


if __name__ == "__main__":
    unittest.main()
