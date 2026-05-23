// agent-review client. Renders unified diff with syntax + word-level
// highlighting and lets you attach comments saved server-side.

const state = {
  mode: 'working',
  base: null,
  diff: null,
  comments: [],
  info: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

async function loadInfo() {
  state.info = await api('/api/info');
  state.base = state.info.default_base;
  $('#repo-info').textContent = `${state.info.repo} · ${state.info.branch}`;
  $('#base-name').textContent = state.base;
}

async function loadCommits() {
  const data = await api('/api/commits?limit=15');
  const ul = $('#commit-list');
  ul.innerHTML = '';
  for (const c of data.commits) {
    const li = document.createElement('li');
    li.className = 'commit-row';
    li.innerHTML = `<span class="sha">${escapeHTML(c.short)}</span><span class="subj">${escapeHTML(c.subject)}</span>`;
    li.title = `${c.author} · ${c.date}\n${c.sha}`;
    li.onclick = async () => {
      state.mode = 'commit';
      $$('.mode').forEach(b => b.classList.remove('active'));
      state.diff = await api(`/api/diff?mode=commit&sha=${encodeURIComponent(c.sha)}`);
      render();
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
  if (state.mode === 'branch' && state.base) url += `&base=${encodeURIComponent(state.base)}`;
  state.diff = await api(url);
  render();
}

function render() {
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

  for (const hunk of file.hunks) {
    const tr = document.createElement('tr');
    tr.className = 'hunk';
    tr.innerHTML = `<td colspan="2">@@ -${hunk.old_start},${hunk.old_lines} +${hunk.new_start},${hunk.new_lines} @@${escapeHTML(hunk.header || '')}</td>`;
    tbody.appendChild(tr);

    const lines = hunk.lines;
    // Pre-compute word-diff for paired contiguous del/add groups of equal length.
    const wordHTML = computeWordDiffs(lines, file.language);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const row = document.createElement('tr');
      const cls = line.type === 'add' ? 'add' : line.type === 'del' ? 'del' : 'ctx';
      row.className = cls;
      row.dataset.idx = i;
      const sideForGutter = line.type === 'del' ? 'old' : 'new';
      const lineForGutter = line.type === 'del' ? line.old : line.new;
      row.dataset.side = sideForGutter;
      row.dataset.line = lineForGutter;
      row.dataset.path = sideForGutter === 'old' ? (file.old_path || '') : (file.new_path || '');

      let contentHTML;
      if (wordHTML[i] != null) {
        contentHTML = wordHTML[i];
      } else {
        contentHTML = highlightCode(line.text, file.language);
      }
      const sym = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
      row.innerHTML = `
        <td class="gutter" title="Add comment">+</td>
        <td class="content"><span class="sym">${sym} </span>${contentHTML}</td>
      `;
      row.querySelector('.gutter').onclick = (e) => {
        e.stopPropagation();
        openCommentForm(row);
      };
      tbody.appendChild(row);
    }
  }
  wrap.appendChild(table);
  return wrap;
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
  el.innerHTML = `
    <div class="meta">
      <strong>${escapeHTML(c.file)}:${c.line}</strong>
      <span>·</span>
      <span>${escapeHTML(when)}</span>
      ${c.resolved ? '<span>· resolved</span>' : ''}
    </div>
    <div class="body"></div>
    <div class="actions">
      <button data-act="toggle">${c.resolved ? 'Reopen' : 'Resolve'}</button>
      <button data-act="edit">Edit</button>
      <button data-act="delete">Delete</button>
    </div>
  `;
  el.querySelector('.body').textContent = c.text;
  el.querySelector('[data-act="toggle"]').onclick = async () => {
    await api(`/api/comments/${c.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved: !c.resolved }),
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
  $$('.mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  loadDiff();
}

function closeSidebarIfMobile() {
  if (window.matchMedia('(max-width: 820px)').matches) {
    document.body.classList.remove('sidebar-open');
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  $$('.mode').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $('#refresh').onclick = async () => {
    await Promise.all([loadDiff(), loadComments(), loadCommits()]);
  };
  $('#sidebar-toggle').onclick = () => document.body.classList.toggle('sidebar-open');
  $('#sidebar-backdrop').onclick = () => document.body.classList.remove('sidebar-open');
  // Close mobile sidebar after picking a file/comment/commit
  $('#sidebar').addEventListener('click', (e) => {
    if (e.target.closest('li')) closeSidebarIfMobile();
  });

  await loadInfo();
  await Promise.all([loadDiff(), loadComments(), loadCommits()]);
});
