import os
import sys
import tempfile
import types
import unittest

sys.modules.setdefault("boto3", types.SimpleNamespace(client=lambda *a, **k: None))  # serve 가 import 시 S3 클라이언트를 만든다

import serve  # noqa: E402


class LayoutMergeTest(unittest.TestCase):
    def test_figures_keep_inner_boxes_others_keep_outer(self):
        d = tempfile.mkdtemp()
        m = os.path.join(d, "official_models", "PP-DocLayout_plus-L")
        os.makedirs(m)
        with open(os.path.join(m, "inference.yml"), "w") as f:
            f.write("Global:\n  model_name: x\nPostProcess:\n  label_list: [paragraph_title, image, text, table, chart]\n")
        os.environ["PADDLE_PDX_CACHE_HOME"] = d
        self.assertEqual(serve.layout_merge_modes(), {0: "large", 1: "small", 2: "large", 3: "large", 4: "small"})

    def test_no_model_file_means_default(self):
        os.environ["PADDLE_PDX_CACHE_HOME"] = tempfile.mkdtemp()
        self.assertIsNone(serve.layout_merge_modes())


if __name__ == "__main__":
    unittest.main()
