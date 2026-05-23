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

Stdlib-only, no install step beyond having this skill on disk.

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

The server script `serve.py` lives in the skill's root directory,
next to this `SKILL.md`. The install path is not fixed — it could
be `~/.claude/skills/agent-review/`, `/opt/agent-review/`, or a
symlink to either. Discover it from inside the agent session and
reuse the resolved path; do **not** hard-code a path.

```sh
# Find this skill's directory by locating SKILL.md in known skill roots.
SKILL_DIR=$(find "$HOME" /opt /usr/local /usr/share \
                -type f -path '*/agent-review/SKILL.md' \
                -o -type l -path '*/agent-review/SKILL.md' \
                2>/dev/null | head -1 | xargs -r dirname)

# Fallback: ask the user where it's installed if discovery fails.
[ -z "$SKILL_DIR" ] && { echo "Could not locate agent-review skill"; exit 1; }

python3 "$SKILL_DIR/serve.py" \
    --repo "$(pwd)" \
    --port 8765 \
    --host 0.0.0.0
```

Use the harness's background-task facility (`run_in_background: true`)
so the server keeps serving while you continue working. On startup the
server prints four lines to stdout, the last of which is:

```
  open:     http://<host>:<port>/<token>/
```

Read that line out of the background-task's output file and report the
exact URL (token included) to the user. The server is ready as soon as
this line appears — no further polling is needed.

Note: every other path returns 404 without the `/<token>/` prefix, so
the URL must be passed to the user verbatim.

Flags:

- `--repo PATH` — git repo to review (defaults to cwd at launch).
- `--port N` — defaults to 8765. Pick another if it conflicts.
- `--host 127.0.0.1` (default) for local-only; `0.0.0.0` for LAN.
- `--comments PATH` — override comments JSON location (defaults to
  `<repo>/.agent-review-comments.json`).
- `--https` — serve over HTTPS using a self-signed cert cached at
  `~/.cache/agent-review/`. Browsers warn once per device, then
  proceed. Requires the `openssl` CLI.

## How to read comments back

Comments are a flat JSON file. Read it before responding to a
"did you see my comments?" question, and treat unseen / unresolved
entries as actionable feedback:

```sh
cat <repo>/.agent-review-comments.json
```

Or fetch just the unseen ones from the server:

```sh
curl -s 'http://127.0.0.1:8765/api/comments?unseen=1'
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
  "seen": false,
  "replies": [{"by": "agent", "text": "fixed in <sha>", "created": "..."}],
  "created": "ISO-8601 UTC timestamp",
  "mode": "working" | "branch" | "commit" | "range",
  "base": "ref the diff was against",
  "head": "ref being diffed"
}
```

## How to acknowledge feedback

After acting on a comment, reply to it (which also marks it seen):

```sh
curl -s -X POST "http://127.0.0.1:8765/api/comments/<id>/replies" \
    -H 'Content-Type: application/json' \
    -d '{"text":"fixed in <sha>","by":"agent"}'
```

Or just mark it seen without replying:

```sh
curl -s -X PATCH "http://127.0.0.1:8765/api/comments/<id>" \
    -H 'Content-Type: application/json' \
    -d '{"seen":true}'
```

Do **not** silently `delete` or `resolve` comments — those actions are
the reviewer's prerogative.

## What the UI shows

- **Working tree** — modified tracked files plus untracked files
  (synthesised via `git diff --no-index /dev/null <path>`).
- **Branch vs base** — current or selected branch vs `main`/`master`.
- **Single commit** — clickable in the sidebar.
- **Range** — pick a commit's `↰` to mark it as the comparison base,
  then click another commit to diff between them.

Sidebar lists files, posted comments, branches (`●` for current),
and recent commits. `A−` / `A+` in the header scale the diff font.

## Hosting on other projects

The skill is project-agnostic. To review any repo, pass `--repo`:

```sh
python3 "$SKILL_DIR/serve.py" --repo /path/to/repo
```

Comments land at `/path/to/repo/.agent-review-comments.json`. Suggest
the user add that filename to the project's `.gitignore`.
