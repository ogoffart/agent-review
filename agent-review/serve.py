#!/usr/bin/env python3
"""Serve a local web UI for reviewing an agent's git changes.

Run from inside a git repo, or pass --repo. Comments are persisted to
{repo}/.agent-review-comments.json so the agent can read them with cat.
"""
from __future__ import annotations

import argparse
import http.server
import json
import os
import re
import socketserver
import subprocess
import sys
import threading
import urllib.parse
import uuid
from datetime import datetime, timezone
from pathlib import Path

STATIC_DIR = Path(__file__).resolve().parent / "static"
HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")

REPO: Path = Path.cwd()
COMMENTS_PATH: Path = Path()
COMMENTS_LOCK = threading.Lock()

EXT_LANG = {
    ".rs": "rust", ".py": "python", ".js": "javascript", ".mjs": "javascript",
    ".ts": "typescript", ".tsx": "tsx", ".jsx": "jsx",
    ".html": "html", ".css": "css", ".scss": "scss", ".json": "json",
    ".md": "markdown", ".sh": "bash", ".bash": "bash", ".zsh": "bash",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp",
    ".go": "go", ".java": "java", ".kt": "kotlin", ".swift": "swift",
    ".rb": "ruby", ".php": "php", ".yaml": "yaml", ".yml": "yaml",
    ".toml": "toml", ".sql": "sql", ".slint": "rust",
    ".xml": "xml", ".lua": "lua",
}


def git(*args: str, check: bool = True) -> str:
    r = subprocess.run(
        ["git", "-C", str(REPO), *args],
        capture_output=True, text=True,
    )
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout


def detect_default_base() -> str:
    for ref in ("main", "master", "trunk"):
        r = subprocess.run(
            ["git", "-C", str(REPO), "rev-parse", "--verify", "--quiet", ref],
            capture_output=True, text=True,
        )
        if r.returncode == 0:
            return ref
    return "HEAD"


def current_branch() -> str:
    return git("rev-parse", "--abbrev-ref", "HEAD").strip()


def language_for(path: str | None) -> str | None:
    if not path:
        return None
    suffix = Path(path).suffix.lower()
    return EXT_LANG.get(suffix)


def parse_unified_diff(text: str) -> list[dict]:
    files: list[dict] = []
    cur_file: dict | None = None
    cur_hunk: dict | None = None
    old_ln = new_ln = 0

    for raw in text.split("\n"):
        if raw.startswith("diff --git "):
            if cur_file is not None:
                files.append(cur_file)
            # diff --git a/<old> b/<new>
            parts = raw.split(" ", 3)
            old_p = parts[2][2:] if parts[2].startswith("a/") else parts[2]
            new_p = parts[3][2:] if parts[3].startswith("b/") else parts[3]
            cur_file = {
                "old_path": old_p,
                "new_path": new_p,
                "status": "modified",
                "language": language_for(new_p or old_p),
                "binary": False,
                "hunks": [],
            }
            cur_hunk = None
        elif cur_file is None:
            continue
        elif raw.startswith("new file mode"):
            cur_file["status"] = "added"
        elif raw.startswith("deleted file mode"):
            cur_file["status"] = "deleted"
        elif raw.startswith("rename from "):
            cur_file["status"] = "renamed"
            cur_file["old_path"] = raw[len("rename from "):]
        elif raw.startswith("rename to "):
            cur_file["new_path"] = raw[len("rename to "):]
            cur_file["language"] = language_for(cur_file["new_path"])
        elif raw.startswith("Binary files"):
            cur_file["binary"] = True
        elif raw.startswith("--- "):
            if raw == "--- /dev/null":
                cur_file["old_path"] = None
        elif raw.startswith("+++ "):
            if raw == "+++ /dev/null":
                cur_file["new_path"] = None
        elif raw.startswith("@@"):
            m = HUNK_RE.match(raw)
            if not m:
                continue
            old_start = int(m.group(1))
            old_count = int(m.group(2) or "1")
            new_start = int(m.group(3))
            new_count = int(m.group(4) or "1")
            header = m.group(5).rstrip()
            cur_hunk = {
                "old_start": old_start, "old_lines": old_count,
                "new_start": new_start, "new_lines": new_count,
                "header": header,
                "lines": [],
            }
            cur_file["hunks"].append(cur_hunk)
            old_ln = old_start
            new_ln = new_start
        elif cur_hunk is not None:
            if raw.startswith("\\"):
                continue  # \ No newline at end of file
            if raw.startswith("+"):
                cur_hunk["lines"].append({
                    "type": "add", "old": None, "new": new_ln, "text": raw[1:],
                })
                new_ln += 1
            elif raw.startswith("-"):
                cur_hunk["lines"].append({
                    "type": "del", "old": old_ln, "new": None, "text": raw[1:],
                })
                old_ln += 1
            elif raw.startswith(" "):
                # Context lines always carry a space prefix in unified diff
                # output; truly empty entries here are trailing newlines.
                cur_hunk["lines"].append({
                    "type": "ctx", "old": old_ln, "new": new_ln,
                    "text": raw[1:],
                })
                old_ln += 1
                new_ln += 1

    if cur_file is not None:
        files.append(cur_file)
    return files


def get_diff(mode: str, base: str | None = None, sha: str | None = None,
             head: str | None = None) -> dict:
    if mode == "working":
        diff_text = git("diff", "--no-color", "HEAD")
        # Include untracked files so they show up in the sidebar too.
        # `git diff --no-index` exits 1 when files differ — expected here.
        untracked = git(
            "ls-files", "--others", "--exclude-standard", "-z",
        ).split("\0")
        for path in untracked:
            if not path:
                continue
            diff_text += git(
                "diff", "--no-color", "--no-index", "--",
                "/dev/null", path, check=False,
            )
        return {
            "mode": "working",
            "base": "HEAD",
            "head": current_branch(),
            "files": parse_unified_diff(diff_text),
        }
    if mode == "branch":
        b = base or detect_default_base()
        cur = current_branch()
        # If a head ref is supplied AND it isn't the checked-out branch, diff
        # the two commit tips directly (no working-tree mixing). Otherwise
        # fall back to `git diff base` which includes staged + unstaged.
        if head and head != cur:
            diff_text = git("diff", "--no-color", b, head)
            head_label = head
        else:
            diff_text = git("diff", "--no-color", b)
            head_label = cur
        return {
            "mode": "branch",
            "base": b,
            "head": head_label,
            "files": parse_unified_diff(diff_text),
        }
    if mode == "commit":
        if not sha:
            raise ValueError("commit mode requires sha")
        diff_text = git("show", "--no-color", "--pretty=format:", sha)
        return {
            "mode": "commit",
            "base": f"{sha}^",
            "head": sha,
            "files": parse_unified_diff(diff_text),
        }
    if mode == "range":
        f = base
        t = head
        if not (f and t):
            raise ValueError("range mode requires both 'from' (base) and 'to' (head)")
        diff_text = git("diff", "--no-color", f, t)
        return {
            "mode": "range",
            "base": f,
            "head": t,
            "files": parse_unified_diff(diff_text),
        }
    raise ValueError(f"unknown mode: {mode}")


def get_branches() -> list[dict]:
    sep = "\x1f"
    fmt = sep.join(["%(refname:short)", "%(objectname:short)",
                    "%(committerdate:iso8601)", "%(subject)"])
    out = git("branch", f"--format={fmt}")
    cur = current_branch()
    branches = []
    for line in out.strip().split("\n"):
        if not line:
            continue
        parts = line.split(sep)
        if len(parts) < 4:
            parts += [""] * (4 - len(parts))
        name = parts[0].lstrip("* ").strip()
        branches.append({
            "name": name,
            "sha": parts[1],
            "date": parts[2],
            "subject": parts[3],
            "current": name == cur,
        })
    return branches


def get_commits(limit: int = 20) -> list[dict]:
    sep = "\x1f"
    rec = "\x1e"
    fmt = sep.join(["%H", "%h", "%s", "%an", "%ae", "%aI"]) + rec
    out = git("log", f"-{limit}", f"--pretty=format:{fmt}")
    commits = []
    for chunk in out.split(rec):
        chunk = chunk.strip("\n")
        if not chunk:
            continue
        parts = chunk.split(sep)
        if len(parts) < 6:
            continue
        commits.append({
            "sha": parts[0],
            "short": parts[1],
            "subject": parts[2],
            "author": parts[3],
            "email": parts[4],
            "date": parts[5],
        })
    return commits


def load_comments() -> dict:
    if not COMMENTS_PATH.exists():
        return {"comments": []}
    try:
        return json.loads(COMMENTS_PATH.read_text())
    except json.JSONDecodeError:
        return {"comments": []}


def save_comments(data: dict) -> None:
    with COMMENTS_LOCK:
        tmp = COMMENTS_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(COMMENTS_PATH)


def add_comment(payload: dict) -> dict:
    required = {"file", "line", "side", "text"}
    missing = required - set(payload)
    if missing:
        raise ValueError(f"missing fields: {sorted(missing)}")
    if payload["side"] not in ("old", "new"):
        raise ValueError("side must be old or new")
    with COMMENTS_LOCK:
        data = load_comments() if not COMMENTS_PATH.exists() else json.loads(COMMENTS_PATH.read_text() or '{"comments":[]}')
    entry = {
        "id": uuid.uuid4().hex[:12],
        "file": payload["file"],
        "line": int(payload["line"]),
        "side": payload["side"],
        "text": payload["text"],
        "mode": payload.get("mode"),
        "base": payload.get("base"),
        "head": payload.get("head"),
        "resolved": False,
        "created": datetime.now(timezone.utc).isoformat(),
    }
    data.setdefault("comments", []).append(entry)
    save_comments(data)
    return entry


def update_comment(cid: str, payload: dict) -> dict | None:
    data = load_comments()
    for c in data.get("comments", []):
        if c["id"] == cid:
            for k in ("text", "resolved"):
                if k in payload:
                    c[k] = payload[k]
            c["updated"] = datetime.now(timezone.utc).isoformat()
            save_comments(data)
            return c
    return None


def delete_comment(cid: str) -> bool:
    data = load_comments()
    before = len(data.get("comments", []))
    data["comments"] = [c for c in data.get("comments", []) if c["id"] != cid]
    if len(data["comments"]) == before:
        return False
    save_comments(data)
    return True


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "AgentReview/0.1"

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    def _json(self, status: int, body) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _bytes(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise ValueError("invalid json body")

    def _serve_static(self, rel: str) -> None:
        if not rel or rel == "/":
            rel = "index.html"
        path = (STATIC_DIR / rel).resolve()
        if not str(path).startswith(str(STATIC_DIR.resolve())) or not path.is_file():
            self._json(404, {"error": "not found"})
            return
        ext = path.suffix.lower()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js":   "application/javascript; charset=utf-8",
            ".css":  "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg":  "image/svg+xml",
        }.get(ext, "application/octet-stream")
        self._bytes(200, path.read_bytes(), ctype)

    def do_GET(self):  # noqa: N802
        try:
            url = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(url.query)
            if url.path == "/" or url.path == "/index.html":
                self._serve_static("index.html")
                return
            if url.path.startswith("/static/"):
                self._serve_static(url.path[len("/static/"):])
                return
            if url.path == "/api/info":
                self._json(200, {
                    "repo": str(REPO),
                    "branch": current_branch(),
                    "default_base": detect_default_base(),
                    "comments_path": str(COMMENTS_PATH),
                })
                return
            if url.path == "/api/commits":
                limit = int(q.get("limit", ["20"])[0])
                self._json(200, {"commits": get_commits(limit)})
                return
            if url.path == "/api/diff":
                mode = q.get("mode", ["working"])[0]
                base = q.get("base", [None])[0]
                sha = q.get("sha", [None])[0]
                head = q.get("head", [None])[0]
                self._json(200, get_diff(mode, base=base, sha=sha, head=head))
                return
            if url.path == "/api/branches":
                self._json(200, {"branches": get_branches()})
                return
            if url.path == "/api/blob":
                ref = q.get("ref", ["HEAD"])[0]
                path = q.get("path", [""])[0]
                if not path:
                    self._json(400, {"error": "path required"})
                    return
                out = git("show", f"{ref}:{path}", check=False)
                self._json(200, {"lines": out.splitlines()})
                return
            if url.path == "/api/comments":
                self._json(200, load_comments())
                return
            self._json(404, {"error": "not found"})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def do_POST(self):  # noqa: N802
        try:
            url = urllib.parse.urlparse(self.path)
            if url.path == "/api/comments":
                body = self._read_json()
                entry = add_comment(body)
                self._json(200, entry)
                return
            self._json(404, {"error": "not found"})
        except ValueError as e:
            self._json(400, {"error": str(e)})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def do_PATCH(self):  # noqa: N802
        try:
            url = urllib.parse.urlparse(self.path)
            if url.path.startswith("/api/comments/"):
                cid = url.path[len("/api/comments/"):]
                body = self._read_json()
                updated = update_comment(cid, body)
                if updated is None:
                    self._json(404, {"error": "comment not found"})
                    return
                self._json(200, updated)
                return
            self._json(404, {"error": "not found"})
        except ValueError as e:
            self._json(400, {"error": str(e)})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def do_DELETE(self):  # noqa: N802
        try:
            url = urllib.parse.urlparse(self.path)
            if url.path.startswith("/api/comments/"):
                cid = url.path[len("/api/comments/"):]
                if not delete_comment(cid):
                    self._json(404, {"error": "comment not found"})
                    return
                self._json(200, {"ok": True})
                return
            self._json(404, {"error": "not found"})
        except Exception as e:
            self._json(500, {"error": str(e)})


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    global REPO, COMMENTS_PATH
    ap = argparse.ArgumentParser(description="Local web UI for reviewing agent diffs.")
    ap.add_argument("--repo", default=os.environ.get("AGENT_REVIEW_REPO", os.getcwd()),
                    help="git repo to review (default: cwd)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("AGENT_REVIEW_PORT", "8765")))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--comments", default=None,
                    help="comments JSON file (default: {repo}/.agent-review-comments.json)")
    args = ap.parse_args()

    REPO = Path(args.repo).resolve()
    if not (REPO / ".git").exists() and not (REPO / ".git").is_file():
        # might still be inside a worktree; let git decide
        r = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--is-inside-work-tree"],
                           capture_output=True, text=True)
        if r.returncode != 0 or r.stdout.strip() != "true":
            print(f"error: {REPO} is not inside a git repository", file=sys.stderr)
            return 2

    COMMENTS_PATH = Path(args.comments) if args.comments else (REPO / ".agent-review-comments.json")

    srv = ThreadingServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/"
    print(f"agent-review serving {REPO}")
    print(f"  comments: {COMMENTS_PATH}")
    print(f"  open:     {url}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    return 0


if __name__ == "__main__":
    sys.exit(main())
