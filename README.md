# agent-review

A small local web UI for reviewing an agent's git changes. Renders the
diff with syntax and word-level highlighting, lets reviewers attach
line-anchored comments, and stores those comments as JSON in the repo so
the agent can read them back next session.

The tool is a single Python file plus a static HTML/JS/CSS frontend. No
build step, no dependencies beyond the standard library.

## Quick start

```sh
python3 serve.py --repo /path/to/your/repo --port 8765
```

Then open `http://127.0.0.1:8765/`. Pass `--host 0.0.0.0` to expose on
your LAN (useful for reviewing from a phone). Pass `--https` to serve
over TLS with a cached self-signed certificate; browsers warn once per
device, then proceed.

## Modes

- **Working tree** — uncommitted edits plus untracked files
- **vs base** — current branch (or a chosen one) compared to `main`/`master`
- **Single commit** — click a sha in the sidebar

## Sidebar

- **Files** in the current view, with `+`/`−` counts
- **Comments** posted so far, click to jump
- **Branches** — tap to diff that branch's tip vs the default base
  (no `git checkout`, your working tree is untouched)
- **Recent commits**

## Comments

Click the `+` gutter on any line to attach a comment. Cmd/Ctrl-Enter
saves, Esc cancels. Comments are written to
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
      "created": "2026-05-23T15:46:32Z"
    }
  ]
}
```

Resolve, edit, or delete inline. Read the file with `cat` to see what
the reviewer asked for.

## Mobile

The sidebar collapses behind a `☰` toggle; long code lines stay on a
single line but the diff box scrolls horizontally and comment forms
stick to the viewport's left edge. `A−`/`A+` in the header scale the
diff font; the choice is remembered in `localStorage`.

## API

| Method  | Path                       | Notes                              |
|---------|----------------------------|------------------------------------|
| GET     | `/api/info`                | repo path, current branch, base    |
| GET     | `/api/commits?limit=N`     | recent commits                     |
| GET     | `/api/branches`            | local branches                     |
| GET     | `/api/diff?mode=…`         | `working` / `branch` / `commit`    |
| GET     | `/api/comments`            | all comments                       |
| POST    | `/api/comments`            | `{file,line,side,text,…}`          |
| PATCH   | `/api/comments/<id>`       | `{text?, resolved?}`               |
| DELETE  | `/api/comments/<id>`       | remove                             |

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

Covers the unified-diff parser, comment CRUD, and language detection.
