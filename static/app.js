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
  commits: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// The page may be mounted under a /<token>/ prefix; derive the API base
// from window.location so calls work without any hard-coded prefix.
const BASE = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
// The URL token (if any) is the last path segment of BASE. Echo it
// back in a custom header on state-changing requests so a malicious
// page can't CSRF-submit comments even if it learns the URL. When
// the server runs without --token, BASE is empty and URL_TOKEN is ''.
const URL_TOKEN = BASE.split('/').pop() || '';
async function api(path, opts) {
  opts = opts || {};
  const method = (opts.method || 'GET').toUpperCase();
  if (URL_TOKEN && method !== 'GET' && method !== 'HEAD') {
    opts.headers = { ...(opts.headers || {}), 'X-Agent-Review-Token': URL_TOKEN };
  }
  const r = await fetch(BASE + path, opts);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// ---- URL hash <-> state ----------------------------------------------------
// State that determines what `loadDiff` will fetch is mirrored to
// location.hash so refresh / back-forward / shareable links work.
let _hashWriteTimer = null;
let _suppressHashWrite = false;

function writeHash() {
  if (_suppressHashWrite) return;
  const params = new URLSearchParams();
  if (state.mode !== 'working') params.set('mode', state.mode);
  if (state.mode === 'commit' && state.commitSha) params.set('sha', state.commitSha);
  if ((state.mode === 'branch' || state.mode === 'range' || state.mode === 'working')
      && state.diff?.base && state.diff.base !== 'HEAD') {
    params.set('base', state.diff.base);
  }
  if ((state.mode === 'branch' || state.mode === 'range') && state.diff?.head) {
    params.set('head', state.diff.head);
  }
  if (state.ignoreWs) params.set('ws', '1');
  const s = params.toString();
  const next = s ? '#' + s : '';
  if (window.location.hash !== next) {
    // Skip the implicit hashchange we're about to cause.
    _suppressHashWrite = true;
    if (next) window.location.hash = next;
    else history.replaceState(null, '', window.location.pathname + window.location.search);
    setTimeout(() => { _suppressHashWrite = false; }, 0);
  }
}

function readHash() {
  const raw = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(raw);
  return {
    mode: params.get('mode') || 'working',
    sha: params.get('sha'),
    base: params.get('base'),
    head: params.get('head'),
    ws: params.get('ws') === '1',
  };
}

async function applyHashState() {
  const h = readHash();
  // URL wins over localStorage for ws; only fall back to the stored
  // preference when there's no hash at all.
  state.ignoreWs = window.location.hash
    ? !!h.ws
    : localStorage.getItem('agent-review-ignore-ws') === '1';
  $('#ignore-ws')?.classList.toggle('active', state.ignoreWs);
  if (!['working', 'branch', 'commit', 'range'].includes(h.mode)) {
    h.mode = 'working';  // unknown / tampered → fall back, don't poison state
  }
  state.mode = h.mode;
  state.commitSha = h.sha || null;
  state.base = h.base || null;
  state.head = h.head || null;
  state.rangeFrom = null;
  $$('.mode').forEach(b => b.classList.toggle('active',
    (b.dataset.mode === 'working' && h.mode === 'working')
    || (b.dataset.mode === 'branch' && h.mode === 'branch')));
  await loadDiff();
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
    case 'working': return `git diff ${d.base || 'HEAD'}`;
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
  const files = state.diff?.files || [];
  let rollup = '';
  if (files.length > 0) {
    let adds = 0, dels = 0;
    for (const f of files) {
      for (const h of f.hunks) {
        for (const l of h.lines) {
          if (l.type === 'add') adds++;
          else if (l.type === 'del') dels++;
        }
      }
    }
    rollup = ` · +${adds} −${dels} in ${files.length} file${files.length === 1 ? '' : 's'}`;
  }
  const text = spec ? `${repo} · ${spec}${rollup}` : repo;
  const info = $('#repo-info');
  info.textContent = text;
  info.title = `${state.info?.repo || ''}\n${spec}`;
  document.title = spec ? `${spec} · agent-review` : 'agent-review';
}

async function loadCommits() {
  const data = await api('/api/commits?limit=20');
  state.commits = data.commits || [];
  state.branchPoint = data.branch_point || null;
  state.branchBase = data.base || null;
  renderCommits();
}

function renderCommits() {
  const ul = $('#commit-list');
  ul.innerHTML = '';

  if (state.rangeFrom) {
    const banner = document.createElement('li');
    banner.className = 'range-banner';
    const short = state.rangeFrom.slice(0, 7);
    banner.innerHTML = `From <span class="sha">${escapeHTML(short)}</span> → pick a commit, or <button class="vs-wt-btn">working tree</button> <span class="clear" title="Cancel">⨯</span>`;
    banner.querySelector('.vs-wt-btn').onclick = async (e) => {
      e.stopPropagation();
      const from = state.rangeFrom;
      state.rangeFrom = null;
      state.mode = 'working';
      state.commitSha = null;
      state.base = from;
      state.head = null;
      $$('.mode').forEach(b => b.classList.remove('active'));
      await loadDiff();
      writeHash();
      renderCommits();
      closeSidebarIfMobile();
    };
    banner.querySelector('.clear').onclick = (e) => {
      e.stopPropagation();
      state.rangeFrom = null;
      renderCommits();
    };
    ul.appendChild(banner);
  }

  // Suppress the branch-point divider when HEAD == base (no divergence,
  // so the divider would land above the first commit and just be noise).
  const showBranchPoint = state.branchPoint
    && state.branchBase
    && state.branchPoint !== state.commits[0]?.sha;
  for (const c of state.commits) {
    if (showBranchPoint && c.sha === state.branchPoint) {
      const sep = document.createElement('li');
      sep.className = 'branch-point';
      sep.innerHTML = `<span>↑ on this branch · ${escapeHTML(state.branchBase)} ↓</span>`;
      sep.title = `Branch point: HEAD diverged from ${state.branchBase} at this commit`;
      ul.appendChild(sep);
    }
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
        state.commitSha = null;
        state.base = state.rangeFrom;
        state.head = c.sha;
      } else {
        state.mode = 'commit';
        state.commitSha = c.sha;
        state.base = null;
        state.head = null;
      }
      $$('.mode').forEach(b => b.classList.remove('active'));
      await loadDiff();
      writeHash();
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
  if (state.mode === 'commit') {
    if (state.commitSha) url += `&sha=${encodeURIComponent(state.commitSha)}`;
  } else if (state.mode === 'range') {
    if (state.base) url += `&base=${encodeURIComponent(state.base)}`;
    if (state.head) url += `&head=${encodeURIComponent(state.head)}`;
  } else if (state.mode === 'branch') {
    if (state.base) url += `&base=${encodeURIComponent(state.base)}`;
    if (state.head) url += `&head=${encodeURIComponent(state.head)}`;
  } else {
    // working mode optionally takes a base ref (e.g. 'compare vs working tree')
    if (state.base) url += `&base=${encodeURIComponent(state.base)}`;
  }
  if (state.ignoreWs) url += '&ignore_ws=1';
  state.diff = await api(url);
  render();
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

  if (state.diff?.commit) {
    root.appendChild(renderCommitMessage(state.diff.commit));
  }
  detectMovedLines(files);
  files.forEach((f, i) => root.appendChild(renderFile(f, i)));
  renderInlineComments();
}

const COMMIT_MSG_FILE = ':commit-message';

function renderCommitMessage(commit) {
  const wrap = document.createElement('div');
  wrap.className = 'file commit-message';
  wrap.id = 'commit-message';
  const header = document.createElement('div');
  header.className = 'file-header';
  header.innerHTML = `
    <span class="status commit">commit ${escapeHTML(commit.short)}</span>
    <span class="path">${escapeHTML(commit.author)}</span>
    <span class="muted">${escapeHTML(commit.date)}</span>
  `;
  wrap.appendChild(header);
  const table = document.createElement('table');
  table.className = 'diff-table msg-table';
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  // line 1 = subject; blank line; body lines starting at 3.
  const lines = [commit.subject || ''];
  if (commit.body) {
    lines.push('');
    for (const l of commit.body.split('\n')) lines.push(l);
  }
  for (let i = 0; i < lines.length; i++) {
    tbody.appendChild(makeMessageRow(lines[i], i + 1, i === 0, commit.sha));
  }
  wrap.appendChild(table);
  return wrap;
}

function makeMessageRow(text, lineNum, isSubject, sha) {
  const row = document.createElement('tr');
  row.className = 'msg' + (isSubject ? ' subject' : '');
  row.dataset.side = 'msg';
  row.dataset.line = String(lineNum);
  row.dataset.path = COMMIT_MSG_FILE;
  row.dataset.head = sha || '';
  row.innerHTML = `
    <td class="content"><span class="sym" title="Add comment">  </span>${escapeHTML(text)}</td>
  `;
  row.querySelector('.sym').onclick = (e) => {
    e.stopPropagation();
    openCommentForm(row);
  };
  return row;
}

function renderFile(file, idx) {
  const wrap = document.createElement('div');
  wrap.className = 'file';
  wrap.id = `file-${idx}`;

  const name = file.new_path || file.old_path || '?';
  const header = document.createElement('div');
  header.className = 'file-header';
  header.dataset.path = name;
  header.dataset.side = 'file';
  header.dataset.line = '';
  header.innerHTML = `
    <span class="status ${file.status}">${file.status}</span>
    <span class="path">${escapeHTML(name)}</span>
    ${file.old_path && file.new_path && file.old_path !== file.new_path
      ? `<span class="muted">← ${escapeHTML(file.old_path)}</span>` : ''}
    <button class="file-comment-btn" title="Comment on this file">+ comment</button>
  `;
  header.querySelector('.file-comment-btn').onclick = (e) => {
    e.stopPropagation();
    openFileComment(wrap, header);
  };
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

  let prevNewEnd = 0;     // last new-line number rendered so far (0 = start of file)
  let prevOldEnd = 0;
  const canExpand = file.status === 'modified' || file.status === 'renamed';

  for (let h = 0; h < file.hunks.length; h++) {
    const hunk = file.hunks[h];

    let gap = null;
    if (canExpand) {
      const gapNewStart = prevNewEnd + 1;
      const gapNewEnd = hunk.new_start - 1;
      const gapOldStart = prevOldEnd + 1;
      const gapOldEnd = hunk.old_start - 1;
      if (gapNewEnd >= gapNewStart) {
        gap = {
          oldStart: gapOldStart, oldEnd: gapOldEnd,
          newStart: gapNewStart, newEnd: gapNewEnd,
        };
      }
    }
    // Suppress the @@ separator when the hunk has no preceding context
    // on either side — i.e., it starts at the very top of the file (or
    // the file didn't exist on that side, in which case start=0). The
    // divider would point at nothing and only add noise above line 1.
    if (hunk.old_start > 1 || hunk.new_start > 1) {
      tbody.appendChild(makeHunkRow(file, hunk, gap));
    }

    const lines = hunk.lines;
    const wordHTML = computeWordDiffs(lines, file.language);
    for (let i = 0; i < lines.length; i++) {
      tbody.appendChild(createLineRow(lines[i], file, wordHTML[i]));
    }

    prevNewEnd = hunk.new_start + hunk.new_lines - 1;
    prevOldEnd = hunk.old_start + hunk.old_lines - 1;
  }
  const hasMoreLines = file.new_total_lines == null
    || prevNewEnd < file.new_total_lines;
  if (canExpand && file.hunks.length > 0 && hasMoreLines) {
    tbody.appendChild(makeTrailingExpandRow(file, prevNewEnd, prevOldEnd));
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
  // Snapshot the line's text on the row so comments can be re-anchored
  // by content when the line moves between diffs (edits above shift
  // line numbers).
  row.dataset.text = line.text;

  let contentHTML;
  if (wordHTMLOverride != null && typeof wordHTMLOverride === 'object') {
    contentHTML = wordHTMLOverride.html;
  } else if (wordHTMLOverride != null) {
    contentHTML = wordHTMLOverride;
  } else {
    contentHTML = highlightCode(line.text, file.language);
  }
  const sym = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
  row.innerHTML = `<td class="content"><span class="sym" title="Add comment">${sym} </span>${contentHTML}</td>`;
  row.querySelector('.sym').onclick = (e) => {
    e.stopPropagation();
    openCommentForm(row);
  };
  return row;
}

function makeHunkRow(file, hunk, gap) {
  const tr = document.createElement('tr');
  tr.className = 'hunk';
  const text = `@@ -${hunk.old_start},${hunk.old_lines} +${hunk.new_start},${hunk.new_lines} @@${escapeHTML(hunk.header || '')}`;
  if (gap) {
    const count = gap.newEnd - gap.newStart + 1;
    tr.innerHTML = `<td><div class="hunk-line"><button class="expand-btn">↕ Show ${count} more line${count === 1 ? '' : 's'}</button><span class="hunk-text">${text}</span></div></td>`;
    tr.querySelector('.expand-btn').onclick = () => expandGap(file, gap, tr);
  } else {
    tr.innerHTML = `<td><div class="hunk-line"><span class="hunk-text">${text}</span></div></td>`;
  }
  return tr;
}

function makeTrailingExpandRow(file, lastNewLine, lastOldLine) {
  const row = document.createElement('tr');
  row.className = 'expand trailing';
  row.innerHTML = `<td><button class="expand-btn">↓ Show remaining lines</button></td>`;
  const btn = row.querySelector('.expand-btn');
  btn.onclick = async () => {
    const ref = contextRef();
    const path = file.new_path || file.old_path;
    if (!path) return;
    let blob;
    try {
      blob = await fetchBlobLines(ref, path);
    } catch (e) {
      btn.textContent = `error: ${e.message}`;
      return;
    }
    const startN = lastNewLine + 1;
    const startO = lastOldLine + 1;
    if (startN > blob.length) { row.remove(); return; }
    const fragment = document.createDocumentFragment();
    for (let n = startN, o = startO; n <= blob.length; n++, o++) {
      fragment.appendChild(createLineRow({
        type: 'ctx', old: o, new: n, text: blob[n - 1] ?? '',
      }, file));
    }
    row.parentNode.insertBefore(fragment, row);
    row.remove();
    renderInlineComments();
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
  const fragment = document.createDocumentFragment();
  for (let n = gap.newStart, o = gap.oldStart; n <= gap.newEnd; n++, o++) {
    const text = blob[n - 1] ?? '';
    fragment.appendChild(createLineRow({
      type: 'ctx', old: o, new: n, text,
    }, file));
  }
  rowEl.replaceWith(fragment);
  renderInlineComments();   // re-anchor any comments hidden in the gap
}

function detectMovedLines(files) {
  // A line counts as "moved" if its trimmed text (length > 3 to avoid
  // pairing trivial lines like "}" or " ") appears as both a deletion
  // and an addition somewhere in the diff. Detection is global across
  // all files, so a block lifted from one file into another is shaded
  // as moved instead of pure del + pure add.
  const dels = new Map();
  for (const file of files) {
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
  }
  for (const file of files) {
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
    // Pair the first min(delCount, addCount) lines for word diff. The
    // surplus on whichever side keeps its plain line highlight — it's a
    // pure delete or pure add, which jsdiff can't usefully word-split.
    const pairs = Math.min(delCount, addCount);
    for (let p = 0; p < pairs; p++) {
      const a = lines[i + p].text;
      const b = lines[j + p].text;
      const parts = Diff.diffWordsWithSpace(a, b);
      // Wrap the words that did NOT change. Loud lines stay calm;
      // the changed parts pop simply by being un-wrapped.
      // Skip unchanged runs that are too small to matter — under 3
      // chars or under 10% of either line — so the highlight stays
      // signal-rich on lines that are mostly rewritten.
      const delRanges = [], addRanges = [];
      const delMin = Math.max(3, Math.ceil(a.length * 0.1));
      const addMin = Math.max(3, Math.ceil(b.length * 0.1));
      let posA = 0, posB = 0;
      let delTail = false, addTail = false;
      for (const x of parts) {
        const len = x.value.length;
        if (x.removed) { posA += len; }
        else if (x.added) { posB += len; }
        else {
          // If this unchanged chunk ends at the end of its line, keep it
          // regardless of size — a trailing match (often the `;` or `)`)
          // anchors the right edge of the line as unchanged.
          const isTailA = posA + len === a.length;
          const isTailB = posB + len === b.length;
          if (len >= delMin || isTailA) delRanges.push([posA, posA + len]);
          if (len >= addMin || isTailB) addRanges.push([posB, posB + len]);
          if (isTailA) delTail = true;
          if (isTailB) addTail = true;
          posA += len; posB += len;
        }
      }
      out[i + p] = {
        html: highlightWithWordSpans(a, language, delRanges),
        tailUnchanged: delTail,
      };
      out[j + p] = {
        html: highlightWithWordSpans(b, language, addRanges),
        tailUnchanged: addTail,
      };
    }
    i = k > i ? k : i + 1;
  }
  return out;
}

// Syntax-highlight `text` and wrap the given [start, end) character
// ranges in `<span class="word">…</span>`, splitting through any hljs
// spans so the syntax color stays intact.
// Don't split a UTF-16 surrogate pair when slicing text by index — the
// high surrogate (D800..DBFF) must stay attached to its low surrogate.
function snapToCodepoint(s, i) {
  if (i <= 0 || i >= s.length) return i;
  const c = s.charCodeAt(i - 1);
  if (c >= 0xD800 && c <= 0xDBFF) return i + 1;
  return i;
}

function highlightWithWordSpans(text, language, ranges) {
  const html = highlightCode(text, language);
  if (!ranges.length) return html;
  const div = document.createElement('div');
  div.innerHTML = html;
  let pos = 0;
  const work = [];
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, null);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const len = node.nodeValue.length;
    const nStart = pos, nEnd = pos + len;
    const hits = [];
    for (const [rs, re] of ranges) {
      if (re <= nStart) continue;
      if (rs >= nEnd) break;
      hits.push([Math.max(0, rs - nStart), Math.min(len, re - nStart)]);
    }
    if (hits.length) work.push({ node, hits });
    pos = nEnd;
  }
  for (const { node, hits } of work) {
    const t = node.nodeValue;
    const parent = node.parentNode;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (let [a, b] of hits) {
      a = snapToCodepoint(t, a);
      b = snapToCodepoint(t, b);
      if (a > last) frag.appendChild(document.createTextNode(t.slice(last, a)));
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = t.slice(a, b);
      frag.appendChild(span);
      last = b;
    }
    if (last < t.length) frag.appendChild(document.createTextNode(t.slice(last)));
    parent.replaceChild(frag, node);
  }
  return div.innerHTML;
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

function openFileComment(wrap, header) {
  // remove any other open forms
  $$('.comment-form-row, .file-comment-form').forEach(r => r.remove());
  const tpl = $('#comment-form-tpl').content.cloneNode(true);
  const form = document.createElement('div');
  form.className = 'file-comment-form';
  form.appendChild(tpl.querySelector('.comment-form'));
  header.after(form);
  const ta = form.querySelector('textarea');
  ta.focus();
  form.querySelector('.cancel').onclick = () => form.remove();
  form.querySelector('.submit').onclick = async () => {
    const text = ta.value.trim();
    if (!text) return;
    const payload = {
      file: header.dataset.path,
      line: null,
      side: 'file',
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
      form.remove();
      await loadComments();
    } catch (e) {
      alert('Failed to save comment: ' + e.message);
    }
  };
}

function openCommentForm(row) {
  // remove any other open forms
  $$('.comment-form-row, .file-comment-form').forEach(r => r.remove());
  const formRow = document.createElement('tr');
  formRow.className = 'comment-row-tr comment-form-row';
  const td = document.createElement('td');
  // Append only the .comment-form element, skipping the surrounding
  // whitespace text nodes that the template's indentation produces —
  // those nodes inherit line-height: 1.5 from .diff-table and would
  // render as ~16px of vertical padding above and below the form.
  const tpl = $('#comment-form-tpl').content.cloneNode(true);
  td.appendChild(tpl.querySelector('.comment-form'));
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
      line: row.dataset.side === 'file' ? null : Number(row.dataset.line),
      side: row.dataset.side,
      text,
      mode: state.mode,
      base: state.diff?.base,
      head: state.diff?.head,
      anchor_text: row.dataset.text ?? null,
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
  $$('.comment-thread-row, .file-thread-block, #orphan-comments').forEach(r => r.remove());
  // Group comments by their anchor. Use JSON.stringify so file paths
  // that contain delimiters can't collide with each other.
  const grouped = new Map();
  for (const c of state.comments) {
    const key = JSON.stringify([c.file, c.side, c.line ?? null, c.head ?? null]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(c);
  }
  const orphaned = [];   // comments whose anchor can't be found in the current view
  for (const [key, list] of grouped) {
    const [file, side, , head] = JSON.parse(key);
    if (side === 'file') {
      // Attach a block-level thread under each matching file-header.
      const headers = $$(`.file-header[data-path="${cssEscape(file)}"]`);
      if (headers.length === 0) { orphaned.push(...list); continue; }
      for (const header of headers) {
        const block = document.createElement('div');
        block.className = 'file-thread-block';
        for (const c of list) block.appendChild(renderCommentThread(c));
        header.after(block);
      }
      continue;
    }
    const line = JSON.parse(key)[2];
    const headFilter = side === 'msg' && head
      ? `[data-head="${cssEscape(head)}"]`
      : '';
    const sel = `tr[data-path="${cssEscape(file)}"][data-side="${side}"][data-line="${line}"]${headFilter}`;
    let rows = $$(sel);
    let moved = false;
    if (rows.length === 0) {
      // Strict anchor failed. Try re-anchoring by text: every comment
      // in the group has the same intended target, so any one's
      // anchor_text will do as a search key.
      const anchorText = list.find(c => c.anchor_text != null)?.anchor_text;
      if (anchorText != null && anchorText !== '') {
        const cands = $$(`tr[data-path="${cssEscape(file)}"][data-side="${side}"][data-text="${cssEscape(anchorText)}"]${headFilter}`);
        if (cands.length === 1) {
          rows = cands;
          moved = true;
        }
      }
    }
    if (rows.length === 0) { orphaned.push(...list); continue; }
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.className = 'comment-row-tr comment-thread-row';
      const td = document.createElement('td');
      for (const c of list) td.appendChild(renderCommentThread(c, { moved, originalLine: line }));
      tr.appendChild(td);
      row.after(tr);
    }
  }
  if (orphaned.length) {
    const root = $('#diff-root');
    const block = document.createElement('div');
    block.className = 'file';
    block.id = 'orphan-comments';
    const header = document.createElement('div');
    header.className = 'file-header';
    header.innerHTML = `<span class="status orphan">orphaned</span>
      <span class="path">${orphaned.length} comment${orphaned.length === 1 ? '' : 's'} not in current view</span>`;
    block.appendChild(header);
    for (const c of orphaned) {
      const thread = renderCommentThread(c, { orphan: true });
      // Pad so anchor info is visible
      const wrap = document.createElement('div');
      wrap.className = 'file-thread-block';
      wrap.appendChild(thread);
      block.appendChild(wrap);
    }
    root.appendChild(block);
  }
}

function renderCommentThread(c, opts) {
  opts = opts || {};
  const el = document.createElement('div');
  el.className = 'comment-thread'
    + (c.resolved ? ' resolved' : '')
    + (opts.orphan ? ' orphan' : '')
    + (opts.moved ? ' moved-anchor' : '');
  const when = new Date(c.created).toLocaleString();
  const replies = c.replies || [];
  const movedBadge = opts.moved
    ? `<span class="badge moved" title="Original line ${opts.originalLine}; re-anchored by matching text">↔ moved</span>`
    : '';
  const orphanBadge = opts.orphan
    ? '<span class="badge orphan" title="The anchor isn\'t in the current diff view">orphan</span>'
    : '';
  el.innerHTML = `
    <div class="meta">
      <strong>${escapeHTML(prettyCommentAnchor(c))}</strong>
      <span>·</span>
      <span>${escapeHTML(when)}</span>
      ${c.seen ? '<span class="badge seen" title="Seen by agent">✓ seen</span>' : ''}
      ${movedBadge}
      ${orphanBadge}
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

function prettyCommentAnchor(c) {
  if (c.side === 'file' || c.line == null) {
    return `${c.file} (file-level)`;
  }
  if (c.file === COMMIT_MSG_FILE) {
    const sha = (c.head || '').slice(0, 7);
    return `commit message${sha ? ` (${sha})` : ''} line ${c.line}`;
  }
  return `${c.file}:${c.line}`;
}

function renderCommentSidebar() {
  const ul = $('#comment-list');
  ul.innerHTML = '';
  $('#comment-count').textContent = state.comments.length ? `(${state.comments.length})` : '';
  for (const c of state.comments) {
    const li = document.createElement('li');
    li.className = 'comment-row' + (c.resolved ? ' resolved' : '');
    li.innerHTML = `<div class="where">${escapeHTML(prettyCommentAnchor(c))}</div><div>${escapeHTML(c.text.slice(0, 120))}</div>`;
    li.onclick = () => {
      let target = null;
      if (c.side === 'file') {
        target = document.querySelector(`.file-header[data-path="${cssEscape(c.file)}"]`);
      } else {
        const headFilter = c.side === 'msg' && c.head
          ? `[data-head="${cssEscape(c.head)}"]`
          : '';
        target = document.querySelector(
          `tr[data-path="${cssEscape(c.file)}"][data-side="${c.side}"][data-line="${c.line}"]${headFilter}`
        );
        if (!target && c.anchor_text) {
          // Strict anchor missing — fall back to text match (the same
          // re-anchor renderInlineComments uses for moved lines).
          target = document.querySelector(
            `tr[data-path="${cssEscape(c.file)}"][data-side="${c.side}"][data-text="${cssEscape(c.anchor_text)}"]${headFilter}`
          );
        }
      }
      // Last resort: the comment couldn't be placed in the diff. Jump
      // to the orphan section at the bottom, if any.
      if (!target) target = document.getElementById('orphan-comments');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    ul.appendChild(li);
  }
}

function cssEscape(s) {
  // CSS.escape isn't on older browsers but should be fine in modern; fallback to simple
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// ---------- wiring ----------

async function setMode(mode) {
  state.mode = mode;
  state.base = null;       // clicking the mode buttons drops any pinned base/head
  state.head = null;       // and resets to the current branch / default base
  state.commitSha = null;
  state.rangeFrom = null;  // and clears any pending range comparison
  $$('.mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  await loadDiff();
  writeHash();
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
    const stop = () => {
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      handle.removeEventListener('lostpointercapture', stop);
      document.body.classList.remove('resizing-sidebar');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('lostpointercapture', stop);
  });
  handle.addEventListener('dblclick', () => applySidebarWidth(280));
}

window.addEventListener('DOMContentLoaded', async () => {
  applyZoom(loadZoom());
  $('#zoom-out').onclick = () => nudgeZoom(-1);
  $('#zoom-in').onclick = () => nudgeZoom(+1);
  // Seed ignoreWs from URL if present, otherwise localStorage. URL wins.
  const h0 = readHash();
  state.ignoreWs = window.location.hash
    ? !!h0.ws
    : localStorage.getItem('agent-review-ignore-ws') === '1';
  const wsBtn = $('#ignore-ws');
  wsBtn.classList.toggle('active', state.ignoreWs);
  wsBtn.onclick = async () => {
    state.ignoreWs = !state.ignoreWs;
    localStorage.setItem('agent-review-ignore-ws', state.ignoreWs ? '1' : '0');
    wsBtn.classList.toggle('active', state.ignoreWs);
    await loadDiff();
    writeHash();
  };
  $$('.mode').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $('#refresh').onclick = async () => {
    await Promise.all([loadDiff(), loadComments(), loadCommits()]);
  };
  $('#sidebar-toggle').onclick = () => document.body.classList.toggle('sidebar-open');
  $('#sidebar-backdrop').onclick = () => document.body.classList.remove('sidebar-open');
  initSidebarResizer();
  // Close mobile sidebar after picking a file/comment/commit
  $('#sidebar').addEventListener('click', (e) => {
    if (e.target.closest('li')) closeSidebarIfMobile();
  });
  window.addEventListener('hashchange', () => {
    if (_suppressHashWrite) return;
    applyHashState().then(() => { loadComments(); loadCommits(); });
  });

  await loadInfo();
  if (window.location.hash) {
    await applyHashState();
    await Promise.all([loadComments(), loadCommits()]);
  } else {
    await Promise.all([loadDiff(), loadComments(), loadCommits()]);
    writeHash();
  }
});
