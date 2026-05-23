---
name: agent-review
description: Launch a local web UI for the user to visually review the agent's git changes — branch diff, working tree, single commit, or range between two commits — and leave line-anchored comments saved as JSON for the agent to read back. Use when the user asks to "review my changes in a browser", "look at the diff visually", "let me comment on this", wants to skim a branch on their phone, or wants to leave inline feedback before merging.
---

# agent-review

`agent-review` is a local Python HTTP server that renders `git diff` as a
browsable web UI with syntax highlighting, word-level diff, and inline
comments. Reviewers click `+` on any line to leave a comment; comments
are persisted to `<repo>/.agent-review-comments.json` so the agent can
read them with `cat` next session.

The server is bundled in this skill's own directory as `serve.py`
(alongside this `SKILL.md`). Reference it via `$HOME` so the command
stays portable across machines:

```sh
SERVE="$HOME/.claude/skills/agent-review/serve.py"
```

Stdlib-only, no install step beyond the skill being present.

## When to use this skill

Invoke proactively when:

- The user asks to review changes in a browser, see the diff visually,
  or leave inline comments.
- The user wants to look at the agent's work on their phone or another
  device.
- The user wants to compare branches or commits without `git checkout`.
- A long agentic task is finishing and the user might want to skim the
  result before committing/merging.

Do **not** use for:

- Pure CLI inspection (`git diff`, `git log` are enough).
- Posting comments to GitHub PRs (use `gh pr comment`).
- Anything requiring auth — this server has none, only bind to
  `0.0.0.0` on trusted networks.

## How to launch

Launch in the background, then tell the user the URL. Poll
`http://127.0.0.1:<port>/api/info` until it returns 200 before
reporting.

```sh
python3 "$HOME/.claude/skills/agent-review/serve.py" \
    --repo "$(pwd)" \
    --port 8765 \
    --host 0.0.0.0
```

Flags:

- `--repo PATH` — git repo to review (defaults to cwd at launch).
- `--port N` — defaults to 8765. Pick another if it conflicts.
- `--host 127.0.0.1` (default) for local-only; `0.0.0.0` for LAN.
- `--comments PATH` — override comments JSON location (defaults to
  `<repo>/.agent-review-comments.json`).

Use the harness's background-task facility (`run_in_background: true`)
so the server keeps serving while you continue working.

## How to read comments back

Comments are a flat JSON file. Always read it before responding to a
"did you see my comments?" question, and treat unresolved entries as
actionable feedback:

```sh
cat <repo>/.agent-review-comments.json
```

Entry shape:

```json
{
  "id": "12-char-hex",
  "file": "path/relative/to/repo",
  "line": 42,
  "side": "new" | "old",
  "text": "the reviewer's comment",
  "resolved": false,
  "created": "ISO-8601 UTC timestamp",
  "mode": "working" | "branch" | "commit" | "range",
  "base": "ref the diff was against",
  "head": "ref being diffed"
}
```

After acting on a comment, do **not** silently delete it — let the user
mark it resolved themselves, or call
`PATCH /api/comments/<id>` with `{"resolved": true}` if they asked you
to clear the backlog.

## What it shows

- **Working tree** — modified tracked files plus untracked files
  (synthesised via `git diff --no-index /dev/null <path>`).
- **Branch vs base** — current or selected branch vs `main`/`master`.
- **Single commit** — clickable in the sidebar.
- **Range** — diff between two commits picked in the sidebar.

Sidebar lists files, posted comments, branches (current is `●`),
and recent commits.

## Hosting on other projects

The skill is project-agnostic. To review any repo:

```sh
python3 "$HOME/.claude/skills/agent-review/serve.py" --repo /path/to/repo
```

Comments land at `/path/to/repo/.agent-review-comments.json`. Suggest
adding that filename to the project's `.gitignore`.
