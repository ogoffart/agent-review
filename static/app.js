// agent-review client. Renders unified diff with syntax + word-level
// highlighting and lets you attach comments saved server-side.

const state = {
  mode: 'working',
  base: null,
  head: null,         // branch tip to view (null = checked-out branch)
  rangeFrom: null,    // sha picked as the "from" end of a range comparison
  diff: null,
  comments: [],
  info: null,
  branches: [],
  commits: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// The page may be mounted under a /<token>/ prefix; derive the API base
// from window.location so calls work without any hard-coded prefix.
const BASE = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
async function api(path, opts) {
  const r = await fetch(BASE + path, opts);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

async function loadInfo() {
  state.info = await api('/api/info');
  state.base = state.info.default_base;
  $('#base-name').textContent = state.base;
  updateHeader();
}

function diffSpec() {
  const d = state.diff;
  if (!d) return '';
  switch (d.mode) {
    case 'working': return 'git diff HEAD';
    case 'branch':  return `git diff ${d.base} ${d.head}`;
    case 'commit':  return `git show ${d.head}`;
    case 'range':   return `git diff ${d.base}..${d.head}`;
    default:        return '';
  }
}

function repoBasename() {
  const p = state.info?.repo || '';
  return p.replace(/\/+$/, '').split('/').pop() || p;
}

function updateHeader() {
  const repo = repoBasename();
  const spec = diffSpec();
  const text = spec ? `${repo} · ${spec}` : repo;
  const info = $('#repo-info');
  info.textContent = text;
  info.title = `${state.info?.repo || ''}\n${spec}`;
  document.title = spec ? `${spec} · agent-review` : 'agent-review';
}

async function loadCommits() {
  const data = await api('/api/commits?limit=20');
  state.commits = data.commits || [];
  renderCommits();
}

function renderCommits() {
  const ul = $('#commit-list');
  ul.innerHTML = '';

  if (state.rangeFrom) {
    const banner = document.createElement('li');
    banner.className = 'range-banner';
    const short = state.rangeFrom.slice(0, 7);
    banner.innerHTML = `Comparing from <span class="sha">${escapeHTML(short)}</span> → click another commit ⨯`;
    banner.title = 'Click to clear';
    banner.onclick = () => { state.rangeFrom = null; renderCommits(); };
    ul.appendChild(banner);
  }

  for (const c of state.commits) {
    const li = document.createElement('li');
    li.className = 'commit-row';
    if (c.sha === state.rangeFrom) li.classList.add('from-selected');
    li.innerHTML = `
      <button class="from-btn" title="Use as comparison base">↰</button>
      <span class="sha">${escapeHTML(c.short)}</span>
      <span class="subj">${escapeHTML(c.subject)}</span>
    `;
    li.title = `${c.author} · ${c.date}\n${c.sha}`;
    li.querySelector('.from-btn').onclick = (e) => {
      e.stopPropagation();
      state.rangeFrom = state.rangeFrom === c.sha ? null : c.sha;
      renderCommits();
    };
    li.onclick = async () => {
      if (state.rangeFrom && state.rangeFrom !== c.sha) {
        state.mode = 'range';
        $$('.mode').forEach(b => b.classList.remove('active'));
        state.diff = await api(
          `/api/diff?mode=range&base=${encodeURIComponent(state.rangeFrom)}&head=${encodeURIComponent(c.sha)}`
        );
      } else {
        state.mode = 'commit';
        $$('.mode').forEach(b => b.classList.remove('active'));
        state.diff = await api(`/api/diff?mode=commit&sha=${encodeURIComponent(c.sha)}`);
      }
      render();
      closeSidebarIfMobile();
    };
    ul.appendChild(li);
  }
}

async function loadComments() {
  const data = await api('/api/comments');
  state.comments = data.comments || [];
  renderCommentSidebar();
  renderInlineComments();
}

async function loadDiff() {
  let url = `/api/diff?mode=${state.mode}`;
  if (state.mode === 'branch') {
    if (state.base) url += `&base=${encodeURIComponent(state.base)}`;
    if (state.head) url += `&head=${encodeURIComponent(state.head)}`;
  }
  if (state.ignoreWs) url += '&ignore_ws=1';
  state.diff = await api(url);
  render();
  renderBranches();
}

async function loadBranches() {
  const data = await api('/api/branches');
  state.branches = data.branches || [];
  renderBranches();
}

function renderBranches() {
  const ul = $('#branch-list');
  if (!ul) return;
  ul.innerHTML = '';
  $('#branch-count').textContent = state.branches.length ? `(${state.branches.length})` : '';
  const activeHead = state.head || state.info?.branch;
  for (const b of state.branches) {
    const li = document.createElement('li');
    li.className = 'branch-row';
    if (b.name === activeHead && state.mode === 'branch') li.classList.add('active');
    if (b.current) li.classList.add('current');
    li.innerHTML = `
      <span class="bullet">${b.current ? '●' : '○'}</span>
      <span class="name">${escapeHTML(b.name)}</span>
      <span class="muted sha">${escapeHTML(b.sha)}</span>
    `;
    li.title = `${b.name}\n${b.subject}\n${b.date}`;
    li.onclick = () => switchToBranch(b.name);
    ul.appendChild(li);
  }
}

async function switchToBranch(name) {
  state.mode = 'branch';
  state.head = name;
  $$('.mode').forEach(b => b.classList.toggle('active', b.dataset.mode === 'branch'));
  await loadDiff();
  closeSidebarIfMobile();
}

function render() {
  updateHeader();
  const root = $('#diff-root');
  root.innerHTML = '';
  const files = state.diff?.files || [];
  $('#diff-empty').style.display = files.length ? 'none' : 'block';
  $('#file-count').textContent = files.length ? `(${files.length})` : '';

  const fileList = $('#file-list');
  fileList.innerHTML = '';
  files.forEach((f, i) => {
    const li = document.createElement('li');
    const name = f.new_path || f.old_path || '?';
    const additions = f.hunks.reduce((s, h) => s + h.lines.filter(l => l.type === 'add').length, 0);
    const deletions = f.hunks.reduce((s, h) => s + h.lines.filter(l => l.type === 'del').length, 0);
    li.innerHTML = `${escapeHTML(name)} <span class="muted">+${additions} −${deletions}</span>`;
    li.title = name;
    li.onclick = () => document.getElementById(`file-${i}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
    fileList.appendChild(li);
  });

  files.forEach((f, i) => root.appendChild(renderFile(f, i)));
  renderInlineComments();
}

function renderFile(file, idx) {
  const wrap = document.createElement('div');
  wrap.className = 'file';
  wrap.id = `file-${idx}`;

  const name = file.new_path || file.old_path || '?';
  const header = document.createElement('div');
  header.className = 'file-header';
  header.innerHTML = `
    <span class="status ${file.status}">${file.status}</span>
    <span class="path">${escapeHTML(name)}</span>
    ${file.old_path && file.new_path && file.old_path !== file.new_path
      ? `<span class="muted">← ${escapeHTML(file.old_path)}</span>` : ''}
  `;
  wrap.appendChild(header);

  if (file.binary) {
    const p = document.createElement('div');
    p.style.padding = '12px';
    p.style.color = 'var(--muted)';
    p.textContent = 'Binary file (no diff).';
    wrap.appendChild(p);
    return wrap;
  }

  const table = document.createElement('table');
  table.className = 'diff-table';
  table.dataset.fileNew = file.new_path || '';
  table.dataset.fileOld = file.old_path || '';
  table.dataset.lang = file.language || '';
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  detectMovedLines(file);

  let prevNewEnd = 0;     // last new-line number rendered so far (0 = start of file)
  let prevOldEnd = 0;
  const canExpand = file.status === 'modified' || file.status === 'renamed';

  for (let h = 0; h < file.hunks.length; h++) {
    const hunk = file.hunks[h];

    if (canExpand) {
      const gapNewStart = prevNewEnd + 1;
      const gapNewEnd = hunk.new_start - 1;
      const gapOldStart = prevOldEnd + 1;
      const gapOldEnd = hunk.old_start - 1;
      if (gapNewEnd >= gapNewStart) {
        tbody.appendChild(makeExpandRow(file, {
          oldStart: gapOldStart, oldEnd: gapOldEnd,
          newStart: gapNewStart, newEnd: gapNewEnd,
        }));
      }
    }

    const tr = document.createElement('tr');
    tr.className = 'hunk';
    tr.innerHTML = `<td colspan="2">@@ -${hunk.old_start},${hunk.old_lines} +${hunk.new_start},${hunk.new_lines} @@${escapeHTML(hunk.header || '')}</td>`;
    tbody.appendChild(tr);

    const lines = hunk.lines;
    const wordHTML = computeWordDiffs(lines, file.language);
    for (let i = 0; i < lines.length; i++) {
      tbody.appendChild(createLineRow(lines[i], file, wordHTML[i]));
    }

    prevNewEnd = hunk.new_start + hunk.new_lines - 1;
    prevOldEnd = hunk.old_start + hunk.old_lines - 1;
  }
  wrap.appendChild(table);
  return wrap;
}

function createLineRow(line, file, wordHTMLOverride) {
  const row = document.createElement('tr');
  const cls = line.type === 'add' ? 'add' : line.type === 'del' ? 'del' : 'ctx';
  row.className = cls + (line.moved ? ' moved' : '');
  if (line.moved) row.title = 'moved';
  const sideForGutter = line.type === 'del' ? 'old' : 'new';
  const lineForGutter = line.type === 'del' ? line.old : line.new;
  row.dataset.side = sideForGutter;
  row.dataset.line = lineForGutter;
  row.dataset.path = sideForGutter === 'old' ? (file.old_path || '') : (file.new_path || '');

  const contentHTML = wordHTMLOverride != null
    ? wordHTMLOverride
    : highlightCode(line.text, file.language);
  const sym = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
  row.innerHTML = `
    <td class="gutter" title="Add comment">+</td>
    <td class="content"><span class="sym">${sym} </span>${contentHTML}</td>
  `;
  row.querySelector('.gutter').onclick = (e) => {
    e.stopPropagation();
    openCommentForm(row);
  };
  return row;
}

function makeExpandRow(file, gap) {
  const row = document.createElement('tr');
  row.className = 'expand';
  const count = gap.newEnd - gap.newStart + 1;
  row.innerHTML = `<td colspan="2"><button class="expand-btn">↕ Show ${count} more line${count === 1 ? '' : 's'}</button></td>`;
  row.querySelector('.expand-btn').onclick = async () => {
    await expandGap(file, gap, row);
  };
  return row;
}

const blobCache = new Map();

function contextRef() {
  // For working mode the unchanged lines are the same in HEAD and the
  // working tree, so HEAD is fine. Otherwise use the "to" side.
  if (state.mode === 'working') return 'HEAD';
  return state.diff?.head || 'HEAD';
}

async function fetchBlobLines(ref, path) {
  const key = `${ref}::${path}`;
  if (blobCache.has(key)) return blobCache.get(key);
  const data = await api(`/api/blob?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`);
  blobCache.set(key, data.lines);
  return data.lines;
}

async function expandGap(file, gap, rowEl) {
  const ref = contextRef();
  const path = file.new_path || file.old_path;
  if (!path) return;
  let blob;
  try {
    blob = await fetchBlobLines(ref, path);
  } catch (e) {
    rowEl.querySelector('.expand-btn').textContent = `error: ${e.message}`;
    return;
  }
  // Remember the next hunk header; we'll hide it once the gap is filled in,
  // since the lines now flow contiguously and the @@ divider is redundant.
  const nextHunk = rowEl.nextElementSibling;
  const fragment = document.createDocumentFragment();
  for (let n = gap.newStart, o = gap.oldStart; n <= gap.newEnd; n++, o++) {
    const text = blob[n - 1] ?? '';
    fragment.appendChild(createLineRow({
      type: 'ctx', old: o, new: n, text,
    }, file));
  }
  rowEl.replaceWith(fragment);
  if (nextHunk && nextHunk.classList.contains('hunk')) {
    nextHunk.style.display = 'none';
  }
  renderInlineComments();   // re-anchor any comments hidden in the gap
}

function detectMovedLines(file) {
  // A line counts as "moved" if its trimmed text (length > 3 to avoid
  // pairing trivial lines like "}" or " ") appears as both a deletion
  // and an addition somewhere in this file. Pair them FIFO so each
  // del/add only matches once.
  const dels = new Map();
  for (const h of file.hunks) {
    for (const l of h.lines) {
      l.moved = false;  // reset across re-renders
      if (l.type === 'del') {
        const t = l.text;
        if (t.trim().length <= 3) continue;
        if (!dels.has(t)) dels.set(t, []);
        dels.get(t).push(l);
      }
    }
  }
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') {
        const matches = dels.get(l.text);
        if (matches && matches.length) {
          const del = matches.shift();
          del.moved = true;
          l.moved = true;
        }
      }
    }
  }
}

function computeWordDiffs(lines, language) {
  const out = new Array(lines.length).fill(null);
  if (typeof Diff === 'undefined') return out;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'del') { i++; continue; }
    let j = i;
    while (j < lines.length && lines[j].type === 'del') j++;
    let k = j;
    while (k < lines.length && lines[k].type === 'add') k++;
    const delCount = j - i;
    const addCount = k - j;
    if (delCount > 0 && delCount === addCount) {
      for (let p = 0; p < delCount; p++) {
        const a = lines[i + p].text;
        const b = lines[j + p].text;
        const parts = Diff.diffWordsWithSpace(a, b);
        out[i + p] = parts.filter(x => !x.added).map(x =>
          x.removed ? `<span class="word">${escapeHTML(x.value)}</span>` : escapeHTML(x.value)
        ).join('');
        out[j + p] = parts.filter(x => !x.removed).map(x =>
          x.added ? `<span class="word">${escapeHTML(x.value)}</span>` : escapeHTML(x.value)
        ).join('');
      }
    }
    i = k > i ? k : i + 1;
  }
  return out;
}

function highlightCode(text, language) {
  if (typeof hljs === 'undefined' || !language) return escapeHTML(text);
  try {
    if (hljs.getLanguage(language)) {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    }
  } catch (_) { /* fall through */ }
  return escapeHTML(text);
}

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---------- comments ----------

function openCommentForm(row) {
  // remove any other open forms
  $$('.comment-form-row').forEach(r => r.remove());
  const formRow = document.createElement('tr');
  formRow.className = 'comment-row-tr comment-form-row';
  const td = document.createElement('td');
  td.colSpan = 2;
  const tpl = $('#comment-form-tpl').content.cloneNode(true);
  td.appendChild(tpl);
  formRow.appendChild(td);
  row.after(formRow);
  const ta = formRow.querySelector('textarea');
  ta.focus();
  formRow.querySelector('.cancel').onclick = () => formRow.remove();
  formRow.querySelector('.submit').onclick = async () => {
    const text = ta.value.trim();
    if (!text) return;
    const payload = {
      file: row.dataset.path,
      line: Number(row.dataset.line),
      side: row.dataset.side,
      text,
      mode: state.mode,
      base: state.diff?.base,
      head: state.diff?.head,
    };
    try {
      await api('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      formRow.remove();
      await loadComments();
    } catch (e) {
      alert('Failed to save comment: ' + e.message);
    }
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') formRow.remove();
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') formRow.querySelector('.submit').click();
  });
}

function renderInlineComments() {
  $$('.comment-thread-row').forEach(r => r.remove());
  const grouped = new Map();
  for (const c of state.comments) {
    const key = `${c.file}|${c.side}|${c.line}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(c);
  }
  for (const [key, list] of grouped) {
    const [file, side, line] = key.split('|');
    const sel = `tr[data-path="${cssEscape(file)}"][data-side="${side}"][data-line="${line}"]`;
    const rows = $$(sel);
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.className = 'comment-row-tr comment-thread-row';
      const td = document.createElement('td');
      td.colSpan = 2;
      for (const c of list) td.appendChild(renderCommentThread(c));
      tr.appendChild(td);
      row.after(tr);
    }
  }
}

function renderCommentThread(c) {
  const el = document.createElement('div');
  el.className = 'comment-thread' + (c.resolved ? ' resolved' : '');
  const when = new Date(c.created).toLocaleString();
  const replies = c.replies || [];
  el.innerHTML = `
    <div class="meta">
      <strong>${escapeHTML(c.file)}:${c.line}</strong>
      <span>·</span>
      <span>${escapeHTML(when)}</span>
      ${c.seen ? '<span class="badge seen" title="Seen by agent">✓ seen</span>' : ''}
      ${c.resolved ? '<span>· resolved</span>' : ''}
    </div>
    <div class="body"></div>
    <div class="replies"></div>
    <div class="actions">
      <button data-act="reply">Reply</button>
      <button data-act="toggle">${c.resolved ? 'Reopen' : 'Resolve'}</button>
      <button data-act="seen">${c.seen ? 'Unsee' : 'Mark seen'}</button>
      <button data-act="edit">Edit</button>
      <button data-act="delete">Delete</button>
    </div>
  `;
  el.querySelector('.body').textContent = c.text;

  const repliesEl = el.querySelector('.replies');
  for (const r of replies) {
    const div = document.createElement('div');
    div.className = 'reply' + (r.by === 'agent' ? ' agent' : ' user');
    const rwhen = r.created ? new Date(r.created).toLocaleString() : '';
    div.innerHTML = `
      <div class="reply-meta">${escapeHTML(r.by || 'unknown')} · ${escapeHTML(rwhen)}</div>
      <div class="reply-body"></div>
    `;
    div.querySelector('.reply-body').textContent = r.text;
    repliesEl.appendChild(div);
  }

  el.querySelector('[data-act="toggle"]').onclick = async () => {
    await api(`/api/comments/${c.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved: !c.resolved }),
    });
    await loadComments();
  };
  el.querySelector('[data-act="seen"]').onclick = async () => {
    await api(`/api/comments/${c.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seen: !c.seen }),
    });
    await loadComments();
  };
  el.querySelector('[data-act="delete"]').onclick = async () => {
    if (!confirm('Delete comment?')) return;
    await api(`/api/comments/${c.id}`, { method: 'DELETE' });
    await loadComments();
  };
  el.querySelector('[data-act="edit"]').onclick = () => {
    const body = el.querySelector('.body');
    const orig = body.textContent;
    const ta = document.createElement('textarea');
    ta.value = orig;
    ta.rows = Math.max(3, Math.min(10, orig.split('\n').length + 1));
    ta.style.width = '100%';
    body.replaceWith(ta);
    const save = document.createElement('button');
    save.textContent = 'Save';
    save.className = 'primary';
    save.onclick = async () => {
      await api(`/api/comments/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ta.value }),
      });
      await loadComments();
    };
    el.querySelector('.actions').prepend(save);
  };
  el.querySelector('[data-act="reply"]').onclick = () => {
    if (el.querySelector('.reply-form')) return;
    const form = document.createElement('div');
    form.className = 'reply-form';
    form.innerHTML = `
      <textarea placeholder="Reply…" rows="2"></textarea>
      <div class="actions">
        <button class="cancel">Cancel</button>
        <button class="primary submit">Send</button>
      </div>
    `;
    repliesEl.after(form);
    const ta = form.querySelector('textarea');
    ta.focus();
    form.querySelector('.cancel').onclick = () => form.remove();
    form.querySelector('.submit').onclick = async () => {
      const text = ta.value.trim();
      if (!text) return;
      await api(`/api/comments/${c.id}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, by: 'user' }),
      });
      await loadComments();
    };
  };
  return el;
}

function renderCommentSidebar() {
  const ul = $('#comment-list');
  ul.innerHTML = '';
  $('#comment-count').textContent = state.comments.length ? `(${state.comments.length})` : '';
  for (const c of state.comments) {
    const li = document.createElement('li');
    li.className = 'comment-row' + (c.resolved ? ' resolved' : '');
    li.innerHTML = `<div class="where">${escapeHTML(c.file)}:${c.line}</div><div>${escapeHTML(c.text.slice(0, 120))}</div>`;
    li.onclick = () => {
      const sel = `tr[data-path="${cssEscape(c.file)}"][data-side="${c.side}"][data-line="${c.line}"]`;
      const row = document.querySelector(sel);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    ul.appendChild(li);
  }
}

function cssEscape(s) {
  // CSS.escape isn't on older browsers but should be fine in modern; fallback to simple
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// ---------- wiring ----------

function setMode(mode) {
  state.mode = mode;
  state.head = null;       // clicking the mode buttons resets to the current branch
  state.rangeFrom = null;  // and clears any pending range comparison
  $$('.mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  loadDiff();
  renderCommits();
}

const ZOOM_STEPS = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75];

function loadZoom() {
  const z = parseFloat(localStorage.getItem('agent-review-zoom'));
  return Number.isFinite(z) && ZOOM_STEPS.includes(z) ? z : 1.0;
}

function applyZoom(z) {
  document.documentElement.style.setProperty('--zoom', String(z));
  localStorage.setItem('agent-review-zoom', String(z));
}

function nudgeZoom(delta) {
  const cur = loadZoom();
  let i = ZOOM_STEPS.indexOf(cur);
  if (i < 0) i = ZOOM_STEPS.indexOf(1.0);
  i = Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + delta));
  applyZoom(ZOOM_STEPS[i]);
}

function closeSidebarIfMobile() {
  if (window.matchMedia('(max-width: 820px)').matches) {
    document.body.classList.remove('sidebar-open');
  }
}

const SIDEBAR_MIN = 160, SIDEBAR_MAX = 720;

function applySidebarWidth(px) {
  const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, px));
  document.documentElement.style.setProperty('--sidebar-w', w + 'px');
  localStorage.setItem('agent-review-sidebar-w', String(w));
}

function initSidebarResizer() {
  const stored = parseInt(localStorage.getItem('agent-review-sidebar-w') || '', 10);
  if (Number.isFinite(stored)) applySidebarWidth(stored);
  const handle = $('#sidebar-resizer');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing-sidebar');
    const move = (ev) => applySidebarWidth(ev.clientX);
    const up = (ev) => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-sidebar');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('dblclick', () => applySidebarWidth(280));
}

window.addEventListener('DOMContentLoaded', async () => {
  applyZoom(loadZoom());
  $('#zoom-out').onclick = () => nudgeZoom(-1);
  $('#zoom-in').onclick = () => nudgeZoom(+1);
  state.ignoreWs = localStorage.getItem('agent-review-ignore-ws') === '1';
  const wsBtn = $('#ignore-ws');
  wsBtn.classList.toggle('active', state.ignoreWs);
  wsBtn.onclick = async () => {
    state.ignoreWs = !state.ignoreWs;
    localStorage.setItem('agent-review-ignore-ws', state.ignoreWs ? '1' : '0');
    wsBtn.classList.toggle('active', state.ignoreWs);
    await loadDiff();
  };
  $$('.mode').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $('#refresh').onclick = async () => {
    await Promise.all([loadDiff(), loadComments(), loadCommits(), loadBranches()]);
  };
  $('#sidebar-toggle').onclick = () => document.body.classList.toggle('sidebar-open');
  $('#sidebar-backdrop').onclick = () => document.body.classList.remove('sidebar-open');
  initSidebarResizer();
  // Close mobile sidebar after picking a file/comment/commit
  $('#sidebar').addEventListener('click', (e) => {
    if (e.target.closest('li')) closeSidebarIfMobile();
  });

  await loadInfo();
  await Promise.all([loadDiff(), loadComments(), loadCommits(), loadBranches()]);
});
