#!/bin/sh
# UserPromptSubmit hook: emit unseen agent-review comments so the agent
# sees feedback the reviewer left between prompts. Silent when there's
# nothing new or no agent-review-comments.json is present.
COMMENTS="${CLAUDE_PROJECT_DIR:-$(pwd)}/.agent-review-comments.json"
[ -f "$COMMENTS" ] || exit 0
exec python3 - "$COMMENTS" <<'PY'
import json, sys

try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except Exception:
    sys.exit(0)

unseen = [c for c in data.get("comments", [])
          if not c.get("seen") and not c.get("resolved")]
if not unseen:
    sys.exit(0)

def anchor(c):
    side = c.get("side", "new")
    if side == "file":
        return f"{c['file']} (file-level)"
    if side == "msg":
        sha = (c.get("head") or "")[:7]
        return f"commit {sha} message line {c['line']}" if sha else f"commit message line {c['line']}"
    return f"{c['file']}:{c['line']} ({side})"

print()
print(f'<agent-review-feedback count="{len(unseen)}" file="{sys.argv[1]}">')
for c in unseen:
    print(f"  [{c['id']}] {anchor(c)}")
    for line in (c.get("text") or "").splitlines():
        print(f"    | {line}")
    for r in c.get("replies") or []:
        print(f"    > {r.get('by','?')}: {r.get('text','')}")
print("</agent-review-feedback>")
print("Address each item via the agent-review API:")
print("  POST  /api/comments/<id>/replies   {text, by:'agent'}   (replies + marks seen)")
print("  PATCH /api/comments/<id>           {seen:true}          (mark seen only)")
PY
