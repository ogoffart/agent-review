"""Unit tests for agent-review's unified-diff parser."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import serve  # noqa: E402


SIMPLE = """diff --git a/foo.py b/foo.py
index 1234567..89abcde 100644
--- a/foo.py
+++ b/foo.py
@@ -1,2 +1,2 @@
 unchanged
-old line
+new line
"""

NEW_FILE = """diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
"""

DELETED_FILE = """diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 1111111..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-goodbye
-world
"""

RENAMED = """diff --git a/old.txt b/new.txt
similarity index 95%
rename from old.txt
rename to new.txt
index 1111111..2222222 100644
--- a/old.txt
+++ b/new.txt
@@ -1 +1 @@
-old content
+new content
"""

MULTI_FILE = SIMPLE + NEW_FILE


class TestParseUnifiedDiff(unittest.TestCase):
    def test_simple_modification(self):
        files = serve.parse_unified_diff(SIMPLE)
        self.assertEqual(len(files), 1)
        f = files[0]
        self.assertEqual(f["old_path"], "foo.py")
        self.assertEqual(f["new_path"], "foo.py")
        self.assertEqual(f["status"], "modified")
        self.assertEqual(f["language"], "python")
        self.assertEqual(len(f["hunks"]), 1)
        types = [l["type"] for l in f["hunks"][0]["lines"]]
        self.assertEqual(types, ["ctx", "del", "add"])

    def test_new_file(self):
        files = serve.parse_unified_diff(NEW_FILE)
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0]["status"], "added")
        self.assertIsNone(files[0]["old_path"])
        self.assertEqual(files[0]["new_path"], "new.txt")
        adds = [l for l in files[0]["hunks"][0]["lines"] if l["type"] == "add"]
        self.assertEqual([l["text"] for l in adds], ["hello", "world"])

    def test_deleted_file(self):
        files = serve.parse_unified_diff(DELETED_FILE)
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0]["status"], "deleted")
        self.assertEqual(files[0]["old_path"], "gone.txt")
        self.assertIsNone(files[0]["new_path"])

    def test_renamed_file(self):
        files = serve.parse_unified_diff(RENAMED)
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0]["status"], "renamed")
        self.assertEqual(files[0]["old_path"], "old.txt")
        self.assertEqual(files[0]["new_path"], "new.txt")

    def test_multiple_files(self):
        files = serve.parse_unified_diff(MULTI_FILE)
        self.assertEqual(len(files), 2)
        self.assertEqual(files[0]["new_path"], "foo.py")
        self.assertEqual(files[1]["new_path"], "new.txt")

    def test_hunk_line_numbering(self):
        files = serve.parse_unified_diff(SIMPLE)
        lines = files[0]["hunks"][0]["lines"]
        ctx = next(l for l in lines if l["type"] == "ctx")
        self.assertEqual(ctx["old"], 1)
        self.assertEqual(ctx["new"], 1)
        delete = next(l for l in lines if l["type"] == "del")
        self.assertEqual(delete["old"], 2)
        self.assertIsNone(delete["new"])
        add = next(l for l in lines if l["type"] == "add")
        self.assertIsNone(add["old"])
        self.assertEqual(add["new"], 2)

    def test_empty_input(self):
        self.assertEqual(serve.parse_unified_diff(""), [])

    def test_binary_file(self):
        diff = (
            "diff --git a/img.png b/img.png\n"
            "index 1111111..2222222 100644\n"
            "Binary files a/img.png and b/img.png differ\n"
        )
        files = serve.parse_unified_diff(diff)
        self.assertEqual(len(files), 1)
        self.assertTrue(files[0]["binary"])
        self.assertEqual(files[0]["hunks"], [])


class TestLanguageDetection(unittest.TestCase):
    def test_known_extensions(self):
        cases = {
            "foo.py": "python",
            "bar.rs": "rust",
            "baz.ts": "typescript",
            "x.html": "html",
            "Cargo.toml": "toml",
            "build.sh": "bash",
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(serve.language_for(path), expected)

    def test_unknown_extension(self):
        self.assertIsNone(serve.language_for("foo.xyz"))

    def test_no_path(self):
        self.assertIsNone(serve.language_for(None))


if __name__ == "__main__":
    unittest.main()
