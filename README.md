# agent-review

A small web UI for reviewing an agent's git changes. Renders the diff
with syntax and word-level highlighting, lets reviewers attach
comments to specific lines (or whole files, or commit messages), and
stores those comments as JSON in the repo so the agent can read them
back next session.

Run it on the machine where your agent works. Open it from the same
machine, from another device on the same network, or — with a port
forward / tunnel / `--host 0.0.0.0` on the right firewall — from
anywhere.

The tool is a single Python file plus a static HTML/JS/CSS frontend.
No build step, no dependencies beyond the standard library
(`openssl` is required only for `--https`).

## Quick start

```sh
python3 serve.py --repo /path/to/your/repo
```

The server prints the URL — copy it from the banner. It includes a
random token segment that gates every endpoint, e.g.
`http://127.0.0.1:8765/abc123def456/`. Paths without the token return
404.

Useful flags:

| Flag | Default | What it does |
|---|---|---|
| `--repo PATH` | cwd | git repo to review |
| `--port N` | `0` (auto) | listen port; `0` lets the OS pick a free one |
| `--host H` | `127.0.0.1` | bind address; use `0.0.0.0` for LAN access |
| `--token T` | random hex | URL-prefix shared secret; `--token ''` disables it |
| `--https` | off | TLS via a cached self-signed cert (`~/.cache/agent-review/`) |
| `--comments PATH` | `<repo>/.agent-review-comments.json` | comments store location |

## Modes

- **Working tree** — uncommitted edits plus untracked files
- **vs base** — current branch compared to the default base (`main`/`master`)
- **Single commit** — click a sha in the sidebar
- **Range** — pick a commit's `↰` to mark it as the base, then click another commit
- **Commit vs working tree** — same `↰` flow but then click "working tree" in the banner

The current view's mode/sha/base/head live in `location.hash`, so
refresh and back/forward replay it, and you can share a URL with
another reviewer.

## Sidebar

- **Files** in the current view, with `+`/`−` counts
- **Comments** posted so far, click to scroll to the anchor
- **Recent commits**, with a divider marking the branch point with the default base

## Comments

- Click the `+` gutter on any diff line to attach a line-anchored comment.
- Click the `+ comment` button on a file header to attach a file-level comment.
- In commit mode, the commit message renders above the diff and accepts comments per line.

Cmd/Ctrl-Enter saves, Esc cancels. Each entry lands in
`<repo>/.agent-review-comments.json`:

```json
{
  "comments": [
    {
      "id": "77b705d9ca31",
      "file": "src/foo.rs",
      "line": 42,
      "side": "new",
      "text": "rename to `score`",
      "resolved": false,
      "seen": false,
      "replies": [],
      "created": "2026-05-23T15:46:32Z",
      "mode": "branch",
      "base": "main",
      "head": "feature-x"
    }
  ]
}
```

Resolve, edit, or delete inline. Read the file with `cat` to see what
the reviewer asked for. `side` is `new`/`old`/`msg`/`file`; `line` is
`null` for file-level comments.

## Mobile

The sidebar collapses behind a `☰` toggle. Long code lines stay on a
single line and the diff box scrolls horizontally; comment forms stick
to the viewport's left edge. `A−`/`A+` in the header scale the diff
font; the choice persists in `localStorage`.

## API

Every endpoint sits under the URL-prefix token; replace `<base>` with
the URL the server printed (including its trailing token segment, e.g.
`http://127.0.0.1:8765/abc123def456`).

| Method  | Path                       | Notes                              |
|---------|----------------------------|------------------------------------|
| GET     | `<base>/api/info`            | repo path, current branch, default base |
| GET     | `<base>/api/commits?limit=N` | recent commits + branch-point sha |
| GET     | `<base>/api/diff?mode=…`     | `working` / `branch` / `commit` / `range` |
| GET     | `<base>/api/blob?ref=&path=` | a file's contents at a tree-ish |
| GET     | `<base>/api/comments`        | all comments (or `?unseen=1`) |
| POST    | `<base>/api/comments`        | `{file,line,side,text,mode?,base?,head?}` |
| POST    | `<base>/api/comments/<id>/replies` | `{text, by:"agent"\|"user"}` |
| PATCH   | `<base>/api/comments/<id>`   | `{text?, resolved?, seen?}` |
| DELETE  | `<base>/api/comments/<id>`   | remove a comment |

State-changing requests (POST/PATCH/DELETE) must echo the URL token in
an `X-Agent-Review-Token: <token>` header. Browsers can't add custom
headers cross-origin without a CORS pre-flight, so this blocks
form-based CSRF even if the URL token leaks.

## Layout

```
serve.py              # HTTP server, diff parser, comment CRUD
SKILL.md              # skill entry-point for Claude Code
notify-hook.sh        # UserPromptSubmit hook for unseen-comment notifications
static/
  index.html
  app.js              # client; uses highlight.js + jsdiff via CDN
  style.css
tests/                # python unittest, run with: python3 -m unittest discover tests
```

## Tests

```sh
python3 -m unittest discover -v tests
```

Covers the unified-diff parser, comment CRUD, validation, and
language detection.
