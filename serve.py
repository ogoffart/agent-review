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
COMMENTS_LOCK = threading.RLock()
TOKEN: str = ""  # required URL prefix; empty disables the check

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
        elif cur_hunk is None and raw.startswith("--- "):
            # File-header marker only meaningful in the pre-hunk preamble;
            # once we're inside a hunk, `--- foo` is just a deleted line
            # whose text happens to start with `-- `.
            if raw == "--- /dev/null":
                cur_file["old_path"] = None
                # `git diff --no-index /dev/null foo` (used for untracked
                # files) lacks a `new file mode` header, so promote the
                # status here.
                if cur_file["status"] == "modified":
                    cur_file["status"] = "added"
        elif cur_hunk is None and raw.startswith("+++ "):
            if raw == "+++ /dev/null":
                cur_file["new_path"] = None
                if cur_file["status"] == "modified":
                    cur_file["status"] = "deleted"
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


CONTEXT_LINES = 6


def _reject_flaglike(value: str, name: str) -> None:
    """Refuse user-supplied refs/paths that could be confused with a git
    flag. Combined with `--end-of-options` this is belt-and-braces."""
    if value.startswith("-"):
        raise ValueError(f"{name} must not start with '-'")


def _count_new_lines(files: list[dict], new_ref: str | None) -> None:
    """Annotate each modified/renamed file with `new_total_lines` so the
    client can suppress the trailing 'Show remaining lines' button when
    the diff already covers the file to EOF.

    `new_ref` is the ref the new side came from, or None for the
    working tree (in which case we read directly from disk)."""
    for f in files:
        if f.get("binary"):
            continue
        if f["status"] not in ("modified", "renamed"):
            continue
        path = f.get("new_path")
        if not path:
            continue
        try:
            if new_ref is None:
                text = (REPO / path).read_text()
            else:
                text = git("show", "--end-of-options", f"{new_ref}:{path}", check=False)
            f["new_total_lines"] = len(text.splitlines())
        except Exception:
            pass


def get_diff(mode: str, base: str | None = None, sha: str | None = None,
             head: str | None = None, ignore_ws: bool = False) -> dict:
    opts: list[str] = ["--no-color", f"-U{CONTEXT_LINES}"]
    if ignore_ws:
        opts.append("-w")  # --ignore-all-space
    if mode == "working":
        base_ref = base or "HEAD"
        _reject_flaglike(base_ref, "base")
        diff_text = git("diff", *opts, "--end-of-options", base_ref)
        # Include untracked files so they show up in the sidebar too.
        # `git diff --no-index` exits 1 when files differ — expected here.
        untracked = git(
            "ls-files", "--others", "--exclude-standard", "-z",
        ).split("\0")
        for path in untracked:
            if not path:
                continue
            diff_text += git(
                "diff", *opts, "--no-index", "--",
                "/dev/null", path, check=False,
            )
        files = parse_unified_diff(diff_text)
        _count_new_lines(files, None)
        return {
            "mode": "working",
            "base": base_ref,
            "head": current_branch(),
            "files": files,
        }
    if mode == "branch":
        b = base or detect_default_base()
        _reject_flaglike(b, "base")
        cur = current_branch()
        if head and head != cur:
            _reject_flaglike(head, "head")
            diff_text = git("diff", *opts, "--end-of-options", b, head)
            head_label = head
        else:
            diff_text = git("diff", *opts, "--end-of-options", b)
            head_label = cur
        files = parse_unified_diff(diff_text)
        _count_new_lines(files, head_label)
        return {
            "mode": "branch",
            "base": b,
            "head": head_label,
            "files": files,
        }
    if mode == "commit":
        if not sha:
            raise ValueError("commit mode requires sha")
        _reject_flaglike(sha, "sha")
        diff_text = git("show", *opts, "--pretty=format:", "--end-of-options", sha)
        sep = "\x1f"
        fmt = sep.join(["%H", "%h", "%s", "%b", "%an", "%ae", "%aI"])
        meta_raw = git("log", "-1", f"--format={fmt}", "--end-of-options", sha).rstrip("\n")
        parts = meta_raw.split(sep)
        commit_meta = {
            "sha":     parts[0] if len(parts) > 0 else sha,
            "short":   parts[1] if len(parts) > 1 else sha[:7],
            "subject": parts[2] if len(parts) > 2 else "",
            "body":    parts[3] if len(parts) > 3 else "",
            "author":  parts[4] if len(parts) > 4 else "",
            "email":   parts[5] if len(parts) > 5 else "",
            "date":    parts[6] if len(parts) > 6 else "",
        }
        files = parse_unified_diff(diff_text)
        _count_new_lines(files, sha)
        return {
            "mode": "commit",
            "base": f"{sha}^",
            "head": sha,
            "commit": commit_meta,
            "files": files,
        }
    if mode == "range":
        f = base
        t = head
        if not (f and t):
            raise ValueError("range mode requires both 'from' (base) and 'to' (head)")
        _reject_flaglike(f, "base")
        _reject_flaglike(t, "head")
        diff_text = git("diff", *opts, "--end-of-options", f, t)
        files = parse_unified_diff(diff_text)
        _count_new_lines(files, t)
        return {
            "mode": "range",
            "base": f,
            "head": t,
            "files": files,
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
    with COMMENTS_LOCK:
        if not COMMENTS_PATH.exists():
            return {"comments": []}
        try:
            return json.loads(COMMENTS_PATH.read_text() or '{"comments":[]}')
        except json.JSONDecodeError:
            return {"comments": []}


def save_comments(data: dict) -> None:
    with COMMENTS_LOCK:
        tmp = COMMENTS_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(COMMENTS_PATH)


MAX_TEXT = 32 * 1024  # 32 KB per comment / reply
MAX_REF = 4 * 1024    # 4 KB per ref-ish string field (file path, sha, mode, base, head)


def _check_text(text: str, field: str = "text", limit: int = MAX_TEXT) -> str:
    if not isinstance(text, str):
        raise ValueError(f"{field} must be a string")
    if len(text) > limit:
        raise ValueError(f"{field} too long ({len(text)} chars; max {limit})")
    return text


def _check_ref(value, field: str):
    if value is None:
        return None
    return _check_text(value, field, MAX_REF)


def add_comment(payload: dict) -> dict:
    required = {"file", "side", "text"}
    missing = required - set(payload)
    if missing:
        raise ValueError(f"missing fields: {sorted(missing)}")
    if payload["side"] not in ("old", "new", "msg", "file"):
        raise ValueError("side must be old, new, msg, or file")
    _check_text(payload["text"])
    _check_ref(payload["file"], "file")
    _check_ref(payload.get("mode"), "mode")
    _check_ref(payload.get("base"), "base")
    _check_ref(payload.get("head"), "head")
    line = payload.get("line")
    # 'file'-level comments aren't anchored to a line; everything else is.
    if payload["side"] == "file":
        line = None
    else:
        if line is None:
            raise ValueError("line is required for line-anchored comments")
        line = int(line)
    entry = {
        "id": uuid.uuid4().hex[:12],
        "file": payload["file"],
        "line": line,
        "side": payload["side"],
        "text": payload["text"],
        "mode": payload.get("mode"),
        "base": payload.get("base"),
        "head": payload.get("head"),
        "resolved": False,
        "seen": False,
        "replies": [],
        "created": datetime.now(timezone.utc).isoformat(),
    }
    with COMMENTS_LOCK:
        data = load_comments()
        data.setdefault("comments", []).append(entry)
        save_comments(data)
    return entry


def update_comment(cid: str, payload: dict) -> dict | None:
    if "text" in payload:
        _check_text(payload["text"])
    with COMMENTS_LOCK:
        data = load_comments()
        for c in data.get("comments", []):
            if c["id"] == cid:
                for k in ("text", "resolved", "seen"):
                    if k in payload:
                        c[k] = payload[k]
                c["updated"] = datetime.now(timezone.utc).isoformat()
                save_comments(data)
                return c
    return None


def add_reply(cid: str, payload: dict) -> dict | None:
    text = (payload.get("text") or "").strip()
    if not text:
        raise ValueError("reply text is required")
    _check_text(text, "reply text")
    with COMMENTS_LOCK:
        data = load_comments()
        for c in data.get("comments", []):
            if c["id"] == cid:
                reply = {
                    "by": payload.get("by") or "agent",
                    "text": text,
                    "created": datetime.now(timezone.utc).isoformat(),
                }
                c.setdefault("replies", []).append(reply)
                c["updated"] = reply["created"]
                # adding a reply implies the responder has now seen it
                if payload.get("by") in (None, "agent"):
                    c["seen"] = True
                save_comments(data)
                return reply
    return None


def unseen_comments() -> list[dict]:
    """Comments not yet marked seen and not resolved."""
    return [
        c for c in load_comments().get("comments", [])
        if not c.get("seen") and not c.get("resolved")
    ]


def delete_comment(cid: str) -> bool:
    with COMMENTS_LOCK:
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

    MAX_BODY = 256 * 1024  # 256 KB is more than enough for a comment

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length > self.MAX_BODY:
            raise ValueError(f"body too large ({length} bytes; max {self.MAX_BODY})")
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise ValueError("invalid json body")

    def _check_csrf(self) -> bool:
        """Require an X-Agent-Review-Token header on state-changing requests.
        Browsers won't add custom headers cross-origin without a CORS
        pre-flight, so this blocks form-style CSRF from another origin
        even if the URL token leaks. Disabled when the URL token is off."""
        if not TOKEN:
            return True
        import secrets
        sent = self.headers.get("X-Agent-Review-Token", "")
        if not secrets.compare_digest(sent, TOKEN):
            self._json(403, {"error": "csrf check failed"})
            return False
        return True

    def _strip_token(self, raw_path: str) -> str | None:
        """Return the path with the token prefix stripped, or None when the
        token is missing/wrong. Sends a 404 itself in the latter case so
        unauthenticated probes can't distinguish a wrong token from a
        random missing route. Issues a redirect when the path is exactly
        '/<token>' (no trailing slash) so relative static URLs resolve."""
        if not TOKEN:
            return raw_path
        import secrets
        url = urllib.parse.urlparse(raw_path)
        prefix = f"/{TOKEN}"
        # `startswith` short-circuits and would leak per-char timing in
        # theory. Use constant-time compare on a fixed-length window.
        candidate = url.path[:len(prefix) + 1]
        if secrets.compare_digest(candidate, prefix + "/"):
            new_path = url.path[len(prefix):] or "/"
            return new_path + (("?" + url.query) if url.query else "")
        if secrets.compare_digest(url.path, prefix):
            self.send_response(301)
            self.send_header("Location", prefix + "/" + (("?" + url.query) if url.query else ""))
            self.end_headers()
            return None
        self._json(404, {"error": "not found"})
        return None

    def _serve_static(self, rel: str) -> None:
        if not rel or rel == "/":
            rel = "index.html"
        path = (STATIC_DIR / rel).resolve()
        try:
            path.relative_to(STATIC_DIR.resolve())
        except ValueError:
            self._json(404, {"error": "not found"})
            return
        if not path.is_file():
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
            stripped = self._strip_token(self.path)
            if stripped is None:
                return
            url = urllib.parse.urlparse(stripped)
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
                raw_limit = q.get("limit", ["20"])[0]
                try:
                    limit = int(raw_limit)
                except ValueError:
                    raise ValueError(f"limit must be an integer (got {raw_limit!r})")
                limit = max(1, min(limit, 500))  # clamp to sane range
                base = detect_default_base()
                bp = git("merge-base", "--end-of-options", "HEAD", base, check=False).strip()
                self._json(200, {
                    "commits": get_commits(limit),
                    "branch_point": bp or None,
                    "base": base,
                })
                return
            if url.path == "/api/diff":
                mode = q.get("mode", ["working"])[0]
                base = q.get("base", [None])[0]
                sha = q.get("sha", [None])[0]
                head = q.get("head", [None])[0]
                ignore_ws = q.get("ignore_ws", ["0"])[0] == "1"
                self._json(200, get_diff(mode, base=base, sha=sha,
                                          head=head, ignore_ws=ignore_ws))
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
                _reject_flaglike(ref, "ref")
                _reject_flaglike(path, "path")
                out = git("show", "--end-of-options", f"{ref}:{path}", check=False)
                self._json(200, {"lines": out.splitlines()})
                return
            if url.path == "/api/comments":
                if q.get("unseen", [""])[0] == "1":
                    self._json(200, {"comments": unseen_comments()})
                else:
                    self._json(200, load_comments())
                return
            self._json(404, {"error": "not found"})
        except ValueError as e:
            self._json(400, {"error": str(e)})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def do_POST(self):  # noqa: N802
        try:
            stripped = self._strip_token(self.path)
            if stripped is None:
                return
            if not self._check_csrf():
                return
            url = urllib.parse.urlparse(stripped)
            if url.path == "/api/comments":
                body = self._read_json()
                entry = add_comment(body)
                self._json(200, entry)
                return
            # POST /api/comments/<id>/replies
            if url.path.startswith("/api/comments/") and url.path.endswith("/replies"):
                cid = url.path[len("/api/comments/"):-len("/replies")]
                body = self._read_json()
                reply = add_reply(cid, body)
                if reply is None:
                    self._json(404, {"error": "comment not found"})
                    return
                self._json(200, reply)
                return
            self._json(404, {"error": "not found"})
        except ValueError as e:
            self._json(400, {"error": str(e)})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def do_PATCH(self):  # noqa: N802
        try:
            stripped = self._strip_token(self.path)
            if stripped is None:
                return
            if not self._check_csrf():
                return
            url = urllib.parse.urlparse(stripped)
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
            stripped = self._strip_token(self.path)
            if stripped is None:
                return
            if not self._check_csrf():
                return
            url = urllib.parse.urlparse(stripped)
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


def ensure_self_signed_cert() -> tuple[Path, Path]:
    """Return (cert_path, key_path), generating a self-signed pair on first
    use and caching it under ~/.cache/agent-review/. Regenerates if the
    cert is expired or missing, or if the cached pair isn't owned by
    the current user (defends against a shared HOME where another user
    could plant a cert+key we'd otherwise trust). Requires `openssl`."""
    import shutil
    if not shutil.which("openssl"):
        raise RuntimeError("openssl CLI not found on PATH; --https requires it")
    cache_dir = Path.home() / ".cache" / "agent-review"
    cache_dir.mkdir(parents=True, exist_ok=True)
    # Tighten the directory mode in case it pre-existed with looser bits.
    try:
        cache_dir.chmod(0o700)
    except OSError:
        pass
    cert = cache_dir / "cert.pem"
    key = cache_dir / "key.pem"

    def _trustworthy(p: Path) -> bool:
        if not p.exists():
            return False
        st = p.stat()
        # Reject files owned by another user, or world/group-writable keys.
        if st.st_uid != os.getuid():
            return False
        if p == key and st.st_mode & 0o077:
            return False
        return True

    if _trustworthy(cert) and _trustworthy(key):
        # Check expiry: regenerate if cert expires within 30 days.
        try:
            r = subprocess.run(
                ["openssl", "x509", "-in", str(cert), "-checkend", str(30 * 86400), "-noout"],
                capture_output=True,
            )
            if r.returncode == 0:
                return cert, key
        except FileNotFoundError:
            raise RuntimeError("openssl CLI not found on PATH; --https requires it")
    # Drop any untrusted leftovers before regenerating.
    for stale in (cert, key):
        if stale.exists():
            try:
                stale.unlink()
            except OSError:
                pass
    try:
        r = subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256",
             "-days", "365", "-nodes",
             "-keyout", str(key), "-out", str(cert),
             "-subj", "/CN=agent-review",
             "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
            capture_output=True, text=True,
        )
    except FileNotFoundError:
        raise RuntimeError("openssl CLI not found on PATH; --https requires it")
    if r.returncode != 0:
        raise RuntimeError(f"openssl failed: {r.stderr.strip() or r.stdout.strip()}")
    # The cert is public, but tighten the private key down to 0600.
    try:
        key.chmod(0o600)
    except OSError:
        pass
    return cert, key


def main() -> int:
    import secrets
    global REPO, COMMENTS_PATH, TOKEN
    # Flush startup lines as they're printed so callers reading the
    # process's stdout (e.g. an agent harness) see the URL and token
    # without having to pass `python3 -u`.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="Local web UI for reviewing agent diffs.")
    ap.add_argument("--repo", default=os.environ.get("AGENT_REVIEW_REPO", os.getcwd()),
                    help="git repo to review (default: cwd)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("AGENT_REVIEW_PORT", "0")),
                    help="port to listen on (default: 0 — OS picks a free one)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--comments", default=None,
                    help="comments JSON file (default: {repo}/.agent-review-comments.json)")
    ap.add_argument("--token", default=None,
                    help="URL path prefix used as a shared-secret guard. "
                         "Default: a fresh 12-char hex token. Use '' to disable.")
    ap.add_argument("--https", action="store_true",
                    help="Serve over HTTPS using a cached self-signed "
                         "certificate at ~/.cache/agent-review/. Browsers "
                         "will warn once per device.")
    args = ap.parse_args()

    REPO = Path(args.repo).resolve()
    TOKEN = args.token if args.token is not None else secrets.token_hex(6)
    if not (REPO / ".git").exists() and not (REPO / ".git").is_file():
        # might still be inside a worktree; let git decide
        r = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--is-inside-work-tree"],
                           capture_output=True, text=True)
        if r.returncode != 0 or r.stdout.strip() != "true":
            print(f"error: {REPO} is not inside a git repository", file=sys.stderr)
            return 2

    COMMENTS_PATH = Path(args.comments) if args.comments else (REPO / ".agent-review-comments.json")

    srv = ThreadingServer((args.host, args.port), Handler)
    scheme = "http"
    if args.https:
        import ssl
        try:
            cert, key = ensure_self_signed_cert()
        except RuntimeError as e:
            print(f"error: {e}", file=sys.stderr)
            return 3
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=str(cert), keyfile=str(key))
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        scheme = "https"
    path_part = f"/{TOKEN}/" if TOKEN else "/"
    display_host = args.host
    if display_host == "0.0.0.0":
        # Help with phone access by also showing a routable host if we can.
        try:
            import socket
            display_host = socket.gethostbyname(socket.gethostname())
        except Exception:
            pass
    # With --port 0 the kernel picks a free port; report what we actually got.
    bound_port = srv.server_address[1]
    url = f"{scheme}://{display_host}:{bound_port}{path_part}"
    print(f"agent-review serving {REPO}")
    print(f"  comments: {COMMENTS_PATH}")
    print(f"  token:    {TOKEN or '(disabled)'}")
    print(f"  open:     {url}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    return 0


if __name__ == "__main__":
    sys.exit(main())
