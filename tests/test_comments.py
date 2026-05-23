"""Integration-style tests for agent-review's comment storage."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "agent-review"))
import serve  # noqa: E402


class TestComments(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        serve.COMMENTS_PATH = Path(self.tmpdir.name) / "comments.json"

    def test_empty_when_no_file(self):
        data = serve.load_comments()
        self.assertEqual(data, {"comments": []})

    def test_add_and_load(self):
        entry = serve.add_comment({
            "file": "foo.py", "line": 10, "side": "new",
            "text": "needs a docstring",
        })
        self.assertEqual(entry["file"], "foo.py")
        self.assertEqual(entry["line"], 10)
        self.assertFalse(entry["resolved"])
        self.assertIn("id", entry)
        self.assertIn("created", entry)

        loaded = serve.load_comments()
        self.assertEqual(len(loaded["comments"]), 1)
        self.assertEqual(loaded["comments"][0]["text"], "needs a docstring")

    def test_add_validates_fields(self):
        with self.assertRaises(ValueError):
            serve.add_comment({"file": "foo.py", "line": 1, "side": "new"})  # no text
        with self.assertRaises(ValueError):
            serve.add_comment({
                "file": "foo.py", "line": 1, "side": "bogus", "text": "x",
            })

    def test_update_text_and_resolve(self):
        a = serve.add_comment({
            "file": "foo.py", "line": 1, "side": "new", "text": "first",
        })
        updated = serve.update_comment(a["id"], {"text": "second", "resolved": True})
        self.assertEqual(updated["text"], "second")
        self.assertTrue(updated["resolved"])
        self.assertIn("updated", updated)

    def test_update_missing(self):
        self.assertIsNone(serve.update_comment("nope", {"text": "x"}))

    def test_delete(self):
        a = serve.add_comment({
            "file": "foo.py", "line": 1, "side": "new", "text": "x",
        })
        self.assertTrue(serve.delete_comment(a["id"]))
        self.assertEqual(serve.load_comments()["comments"], [])
        self.assertFalse(serve.delete_comment(a["id"]))


if __name__ == "__main__":
    unittest.main()
