// Fernando's mission control. Plain JS, no build step. Talks only to the owner API
// (or, on claude.ai, through the transport in claude-transport.js).
'use strict';

// Board column order: what needs Fernando first, then the flow of work.
const STATUSES = [
  ['needs_fernando', 'Needs Fernando'], ['ready', 'Ready'], ['in_progress', 'In Progress'], ['review', 'Review'],
  ['blocked', 'Blocked'], ['backlog', 'Backlog'], ['done', 'Done'],
];
const STATUS_LABEL = Object.fromEntries(STATUSES);
const GATES = ['', 'purchase', 'job_offer', 'credentials', 'other'];
const MEMORY_KINDS = ['decision', 'rule', 'worked', 'failed', 'fact'];
const MESSAGE_KINDS = ['update', 'question', 'answer', 'feedback', 'blocker', 'achievement'];
const AGENT_COLORS = { claude: '#d97757', chatgpt: '#10a37f', gemini: '#4285f4', muse: '#a855f7' };
const UPLOAD_LIMIT = 700 * 1024;
const TEXT_EXT = /\.(md|txt|csv|json|html?|xml|ya?ml|js|ts|py|css|sql|log|ini|toml)$/i;
const DOWNLOAD_EXT = /\.(gif|png|jpe?g|webp|mp4|webm|txt|json|md|docx|pptx|epub|csv|ttf|html|svg|pdf|xlsx|zip)$/i;

const API = window.BOARD_API || '/api';
const $ = (sel, root = document) => root.querySelector(sel);
const state = { snap: null, view: 'home', project: '', showSuperseded: false, folder: '', showTrash: false };

// ---------- helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function until(ts) {
  const m = Math.round((new Date(ts).getTime() - Date.now()) / 60000);
  return m >= 0 ? `${m}m left` : `${-m}m overdue`;
}
function stamp(ts) {
  return ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
}
function day(ts) {
  return new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtNum(n) {
  n = Number(n || 0);
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
function fmtBytes(n) {
  n = Number(n || 0);
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
function cadenceMs(text) {
  const t = String(text || '').toLowerCase();
  const n = parseFloat((t.match(/(\d+(\.\d+)?)/) || [])[1] || '1');
  if (/min/.test(t)) return n * 60e3;
  if (/hour|hr/.test(t)) return n * 3600e3;
  if (/day|daily/.test(t)) return n * 86400e3;
  if (/week/.test(t)) return n * 7 * 86400e3;
  return null;
}
function options(list, selected) {
  return list.map((o) => {
    const [v, l] = Array.isArray(o) ? o : [o, o || '—'];
    return `<option value="${esc(v)}"${String(v) === String(selected ?? '') ? ' selected' : ''}>${esc(l)}</option>`;
  }).join('');
}
function token() {
  try { return localStorage.getItem('board_owner_token') || ''; } catch { return ''; }
}
function setToken(v) {
  try { v ? localStorage.setItem('board_owner_token', v) : localStorage.removeItem('board_owner_token'); } catch { /* private mode */ }
}
function remember(k, v) {
  try { localStorage.setItem(k, v); } catch { /* ignore */ }
}
function recall(k) {
  try { return localStorage.getItem(k) || ''; } catch { return ''; }
}
function flash(msg, kind = 'success') {
  const el = $('#flash');
  el.innerHTML = `<div class="${kind}">${esc(msg)}</div>`;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { el.innerHTML = ''; }, kind === 'error' ? 9000 : 4500);
}
function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      if (el.dataset.group) (out[el.dataset.group] ||= []).push(...(el.checked ? [el.value] : []));
      else out[el.name] = el.checked;
    } else if (el.type === 'radio') {
      if (el.checked) out[el.name] = el.value;
    } else out[el.name] = el.value;
  }
  return out;
}
function colorFor(id) {
  if (AGENT_COLORS[id]) return AGENT_COLORS[id];
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 52%)`;
}

// In-page confirmation. Hosts like claude.ai ignore window.confirm().
function ask(message, yesLabel = 'Confirm') {
  const d = $('#ask');
  $('#ask-text').textContent = message;
  $('#ask-yes').textContent = yesLabel;
  return new Promise((resolve) => {
    const done = (v) => { d.close(); $('#ask-yes').onclick = $('#ask-no').onclick = null; resolve(v); };
    $('#ask-yes').onclick = () => done(true);
    $('#ask-no').onclick = () => done(false);
    d.oncancel = () => done(false);
    d.showModal();
  });
}

async function copyText(text, el) {
  try {
    await navigator.clipboard.writeText(text);
    flash('Copied.');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    flash('Selected. Copy it with your device\'s copy command.', 'notice');
  }
}

function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function downloadFile(name, content, encoding) {
  const filename = name.split('/').pop();
  const data = encoding === 'base64' ? b64ToBytes(content) : content;
  if (window.BOARD_DOWNLOAD) {
    if (!DOWNLOAD_EXT.test(filename)) return flash('This file type can\'t be saved from here. Open it on a device with the Agent Desk, or ask an agent for a copy in another format.', 'error');
    try { await window.BOARD_DOWNLOAD(filename, data); } catch (e) { flash(e.message, 'error'); }
    return;
  }
  const url = URL.createObjectURL(new Blob([data]));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function api(action, args = {}) {
  // A host can supply its own transport (the claude.ai build routes through the Supabase connector).
  if (window.BOARD_TRANSPORT) return window.BOARD_TRANSPORT(action, args, token());
  const r = await fetch(`${API}/owner/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, 'X-Board-Client': 'dashboard' },
    body: JSON.stringify(args),
  });
  const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

async function load(quiet = false) {
  try {
    const prev = state.snap;
    state.snap = await api('snapshot');
    $('#synced').textContent = 'synced ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    render();
    syncSchedules();
    if (prev) showReplies(prev, state.snap);
    if (prev) celebrateFinished(prev, state.snap);
    else {
      // First load: celebrate what finished since the last visit on this device (first visit: last 2 hours).
      const since = Date.parse(recall('board_seen_at') || '') || Date.now() - 2 * 3600e3;
      const before = state.snap.tasks.map((t) => (t.status === 'done' && Date.parse(t.updated_at) > since ? { ...t, status: 'review' } : t));
      setTimeout(() => celebrateFinished({ tasks: before }, state.snap), 400);
    }
    remember('board_seen_at', state.snap.board_time || new Date().toISOString());
  } catch (e) {
    if (e.status === 401) return showLogin('That token was not accepted.');
    if (!quiet) flash(e.message, 'error');
  }
}

// New messages to Fernando from an agent: show them as they land (the ping window, a note, and a
// speech bubble over the agent on the Floor).
function showReplies(prev, snap) {
  const seen = Math.max(0, ...prev.messages.map((m) => m.id));
  const agents = new Set(snap.agents.map((a) => a.id));
  const fresh = snap.messages.filter((m) => m.id > seen && m.to_agent === 'fernando' && agents.has(m.author)).reverse();
  for (const m of fresh) {
    flash(`💬 ${agentName(m.author)}: ${m.body}`);
    if (typeof Office !== 'undefined') Office.say(m.author, m.body);
    const box = $('#ping-reply');
    if (box && state.live && state.live.agent === m.author) {
      box.innerHTML = `<strong>💬 ${esc(agentName(m.author))}</strong> <span class="muted small">just now</span><br>${esc(m.body)}`;
      box.classList.add('got');
    }
    if (state.live && state.live.agent === m.author) state.live = null;
  }
}

// Tasks that turned Done since the last refresh get confetti: from their card on the Board, and
// from the agent who did the work on the Floor (it celebrates there later if the Floor is hidden).
function celebrateFinished(prev, snap) {
  const before = new Map(prev.tasks.map((t) => [t.id, t.status]));
  const done = snap.tasks.filter((t) => t.status === 'done' && before.has(t.id) && before.get(t.id) !== 'done');
  if (!done.length) return;
  flash(done.length === 1 ? `🎉 ${done[0].ref} is done: ${done[0].title}` : `🎉 ${done.length} tasks are done!`);
  for (const t of done) {
    if (t.owner && typeof Office !== 'undefined') Office.celebrate(t.owner);
    if (state.view !== 'floor' && typeof Confetti !== 'undefined') Confetti.fromElement($(`.card[data-task="${t.id}"]`));
  }
  if (state.view === 'floor' && !done.some((t) => t.owner) && typeof Confetti !== 'undefined') Confetti.fromElement(null);
}

async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (r && r.notice) flash(r.notice, 'notice'); else if (okMsg) flash(okMsg);
    await load(true);
    return r;
  } catch (e) {
    flash(e.message, 'error');
    throw e;
  }
}

// ---------- dialog ----------

function openDialog(title, html, onSubmit) {
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = html;
  const d = $('#dialog');
  const form = $('form', d);
  if (form && onSubmit) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = ev.submitter;
      if (btn) btn.disabled = true;
      try {
        const keep = await onSubmit(formData(form), btn && btn.value);
        if (keep !== 'keep-open' && d.open) d.close();
      } catch (e) {
        const box = $('.dialog-error', d);
        if (box) { box.textContent = e.message; box.classList.remove('hidden'); }
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }
  if (!d.open) d.showModal();
  $('#dialog-body').scrollTop = 0;
  return d;
}
$('#dialog-close').addEventListener('click', () => $('#dialog').close());

// ---------- shared bits ----------

const projectsById = () => Object.fromEntries((state.snap.projects || []).map((p) => [p.id, p]));
const activeProjects = () => state.snap.projects.filter((p) => p.status !== 'archived');
const liveAgents = () => state.snap.agents.filter((a) => !a.retired_at);
const agentIds = () => liveAgents().map((a) => a.id);
const agentName = (id) => (state.snap.agents.find((a) => a.id === id) || {}).display_name || id;
const visibleTasks = () => state.snap.tasks.filter((t) => !state.project || t.project === state.project);
const hint = (text) => `<p class="hint">${text}</p>`;
const pendingRequests = () => (state.snap.schedule_requests || []).filter((r) => r.status === 'pending');
const openConflicts = () => (state.snap.conflicts || []).filter((c) => c.status === 'open');
// Everything waiting on Fernando, as Home lists it (approvals, schedule requests, his conflicts, open questions).
const needsMe = () => Home.needs().length;
const avatarOf = (id) => (state.snap.avatars || {})[id] || '';
// An agent's face: its custom sprite picture if it has one, else the drawn bot.
const face = (a, st, size = '') => (avatarOf(a.id)
  ? `<span class="face ${size} st-${st}" style="--c:${colorFor(a.id)}"><img src="${avatarOf(a.id)}" alt="${esc(a.display_name)}"></span>`
  : sprite(a, st, size));
const skillsVocab = () => (state.snap.manager && state.snap.manager.skills_vocab) || [];
const skillChecks = (selected = []) => `<div class="checks">${skillsVocab().map((k) => `<label class="inline"><input type="checkbox" name="skills" data-group="skills" value="${k}"${selected.includes(k) ? ' checked' : ''}> ${k}</label>`).join('')}</div>`;

// The Floor Manager's corner: schedule changes waiting for Fernando, and how recent work was routed.
function managerPanel() {
  const reqs = pendingRequests();
  const routed = state.snap.events.filter((e) => e.action === 'routed').slice(0, 3);
  if (!reqs.length && !routed.length) return '';
  const cards = reqs.map((r) => `<div class="mgr-req">
      <div><strong>${esc(agentName(r.agent_id))}</strong> ${r.source === 'agent' ? 'asks' : '<span class="muted">· Floor Manager suggests</span>'} to run <strong>${esc(r.every)}</strong>${r.until ? ' until ' + esc(stamp(r.until)) : ''} <span class="muted small">(now ${esc(r.prev_every)})</span>
        <div class="small muted">${esc(r.reason)}</div></div>
      <div class="actions" style="margin:0"><button class="btn small primary" data-sched-approve="${r.id}">Approve</button><button class="btn small" data-sched-change="${r.id}">Change…</button><button class="btn small" data-sched-decline="${r.id}">Decline</button></div>
    </div>`).join('');
  const log = routed.map((e) => `<li>${ago(e.at)} · <a href="#" data-task="${e.task_id}">T-${e.task_id}</a> → <strong>${esc(agentName(e.detail.to))}</strong>${e.detail.from && e.detail.from !== e.detail.to ? ` <span class="muted">(was ${esc(agentName(e.detail.from))})</span>` : ''} <span class="muted">· ${esc((e.detail.why || []).join(', '))}</span></li>`).join('');
  return `<section class="panel mgr"><div class="row-head"><h2>🧭 Floor Manager</h2><button class="btn small" id="run-manager">Run now</button></div>
    ${cards}${log ? `<div class="small muted mgr-sub">Recent routing</div><ul class="mgr-log">${log}</ul>` : ''}</section>`;
}

// Sources that disagree, waiting for a decision. Fernando can decide any of them; the ones marked for
// him also count in "need you".
function conflictsPanel() {
  const open = openConflicts();
  if (!open.length) return '';
  const cards = open.map((c) => `<div class="conflict">
      <div class="conflict-head"><strong>⚖️ #${c.id} ${esc(c.about)}</strong>
        <span class="small muted">${esc(c.project || 'board-wide')}${c.task_id ? ` · <a href="#" data-task="${c.task_id}">T-${c.task_id}</a> waits` : ''} · raised by ${esc(agentName(c.raised_by))} ${ago(c.created_at)}</span></div>
      <div class="conflict-sides"><div><span class="label">Source A</span>${esc(c.source_a)}</div><div><span class="label">Source B</span>${esc(c.source_b)}</div></div>
      <div class="actions" style="margin:0"><span class="small muted">${c.decide === 'fernando' ? 'Your call' : `${esc(agentName((state.snap.projects.find((p) => p.slug === c.project) || {}).supervisor || 'supervisor'))} (Supervisor) decides; you can too`}</span>
        <button class="btn small primary" data-conflict="${c.id}">Decide…</button></div>
    </div>`).join('');
  return `<section class="panel conflicts"><h2>Sources that disagree <span class="badge">${open.length}</span></h2>${cards}</section>`;
}

function conflictDialog(id) {
  const c = openConflicts().find((x) => x.id === id);
  if (!c) return flash('That conflict was already decided.', 'error');
  openDialog(`Decide conflict #${c.id}`, `<form>
    <div class="dialog-error error hidden"></div>
    <p><strong>${esc(c.about)}</strong></p>
    <div class="conflict-sides"><div><span class="label">Source A</span>${esc(c.source_a)}</div><div><span class="label">Source B</span>${esc(c.source_b)}</div></div>
    <div class="actions"><button class="btn small" type="button" data-pick="A is right: ${esc(c.source_a)}">A is right</button><button class="btn small" type="button" data-pick="B is right: ${esc(c.source_b)}">B is right</button></div>
    <label for="cf-res">Decision (saved to Memory so nobody asks again)</label>
    <textarea id="cf-res" name="resolution" rows="3" required placeholder="Which one is right, and what everyone should do from now on."></textarea>
    <label for="cf-sup">Replaces memory entry # (optional)</label><input id="cf-sup" name="supersedes" inputmode="numeric" placeholder="e.g. 12">
    <div class="actions"><button class="btn primary">Decide</button></div>
  </form>`, async (f) => {
    await act(() => api('resolve_conflict', { id: c.id, resolution: f.resolution, supersedes: f.supersedes }), `Conflict #${c.id} decided and saved to Memory.`);
  });
  for (const b of document.querySelectorAll('#dialog [data-pick]')) b.addEventListener('click', () => { $('#cf-res').value = b.dataset.pick; $('#cf-res').focus(); });
}

function agentState(a) {
  if (a.status === 'paused') return ['paused', 'Paused'];
  if (a.active_task) return ['working', `Working on ${a.active_task.ref}`];
  if (!a.last_seen_at) return ['offline', 'Not connected yet'];
  const due = cadenceMs(a.clock_in_every);
  if (due && Date.now() - new Date(a.last_seen_at).getTime() > due * 1.5) return ['late', 'Overdue'];
  return ['idle', 'Between turns'];
}

function sprite(a, st, size = '') {
  return `<svg class="sprite st-${st} ${size}" viewBox="0 0 120 96" role="img" aria-label="${esc(a.display_name)}: ${esc(st)}" style="--c:${colorFor(a.id)}">
    <rect class="desk" x="6" y="72" width="108" height="7" rx="3"/>
    <rect class="leg" x="14" y="79" width="5" height="15" rx="2"/><rect class="leg" x="101" y="79" width="5" height="15" rx="2"/>
    <rect class="laptop" x="64" y="48" width="40" height="25" rx="3"/>
    <rect class="screen" x="67" y="51" width="34" height="18" rx="2"/>
    <g class="dots"><circle cx="76" cy="60" r="2.2"/><circle cx="84" cy="60" r="2.2"/><circle cx="92" cy="60" r="2.2"/></g>
    <g class="bot">
      <rect class="body" x="20" y="46" width="34" height="27" rx="9"/>
      <rect class="arm" x="50" y="56" width="16" height="6" rx="3"/>
      <rect class="head" x="18" y="14" width="38" height="32" rx="11"/>
      <line class="antenna" x1="37" y1="14" x2="37" y2="6"/><circle class="bulb" cx="37" cy="5" r="3.2"/>
      <g class="eyes"><rect x="26" y="25" width="7" height="10" rx="3.5"/><rect x="41" y="25" width="7" height="10" rx="3.5"/></g>
      <rect class="mouth" x="31" y="38" width="12" height="2.5" rx="1.2"/>
    </g>
    <text class="zz" x="60" y="22">z</text><text class="zz zz2" x="68" y="14">z</text>
    <g class="pause"><circle cx="100" cy="18" r="11"/><rect x="95" y="12" width="3.5" height="12" rx="1"/><rect x="101.5" y="12" width="3.5" height="12" rx="1"/></g>
  </svg>`;
}

function meter(label, used, total, detail) {
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const tone = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok';
  return `<div class="meter-row"><div class="meter-label"><span>${esc(label)}</span><span class="mono">${esc(detail)}</span></div>
    <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(label)}"><div class="meter-bar ${tone}" style="width:${pct}%"></div></div></div>`;
}

function taskCard(t) {
  const pills = [];
  if (t.priority === 1) pills.push('<span class="pill p1">P1</span>');
  pills.push(`<span class="pill">${esc(t.role_tag)}</span>`);
  if (t.assignee && t.status !== 'in_progress') pills.push(`<span class="pill who" style="--c:${colorFor(t.assignee)}">for ${esc(agentName(t.assignee))}</span>`);
  if (t.owner) pills.push(`<span class="pill who" style="--c:${colorFor(t.owner)}">${esc(agentName(t.owner))}</span>`);
  if (t.human_gate) pills.push(`<span class="pill gate">gate: ${esc(t.human_gate)}</span>`);
  for (const f of t.flags || []) pills.push(`<span class="pill flag">${esc(f.replace(/_/g, ' '))}</span>`);
  if (t.status === 'in_progress' && t.lease_expires_at) pills.push(`<span class="pill">${until(t.lease_expires_at)}</span>`);
  if (t.due_date) pills.push(`<span class="pill">due ${esc(t.due_date)}</span>`);
  if (t.depends_on_open && t.depends_on_open.length) pills.push(`<span class="pill">waits ${esc(t.depends_on_open.join(', '))}</span>`);
  return `<div class="card" data-task="${t.id}" tabindex="0">
    <div class="ref">${esc(t.ref)} · ${esc(t.project)}</div>
    <div class="title">${esc(t.title)}</div>
    <div class="meta">${pills.join('')}</div>
  </div>`;
}

// ---------- views ----------

function viewFloor() {
  const agents = liveAgents();
  const working = agents.filter((a) => a.active_task).length;
  const waiting = needsMe();
  const toMe = state.snap.messages.filter((m) => m.to_agent === 'fernando' && Date.now() - new Date(m.created_at).getTime() < 2 * 86400e3).length;
  const team = agents.map((a) => {
    const [st, label] = agentState(a);
    const what = a.active_task ? `${a.active_task.ref} · ${a.active_task.title}` : a.last_summary || 'No report yet';
    return `<button class="team-row" data-office-select="${esc(a.id)}" style="--c:${colorFor(a.id)}">
      ${avatarOf(a.id) ? `<span class="face tiny"><img src="${avatarOf(a.id)}" alt=""></span>` : '<span class="of-dot"></span>'}<span class="team-text"><span class="who">${esc(a.display_name)}</span> <span class="pill state-${st}">${esc(label)}</span>
      <span class="what">${esc(what)}</span></span></button>`;
  }).join('');
  return `${hint('Click an agent for details, right-click (or long-press) for options, drag to move it. Drop one on the bulletin board to give it a task. The bulletin board, mailbox, cabinet, safe, trophy shelf, whiteboard and server rack open their tabs.')}
    <div class="summary-row">
      <span class="chip"><strong>${working}</strong> working</span>
      <span class="chip"><strong>${agents.length - working}</strong> between turns or paused</span>
      <span class="chip ${waiting ? 'attention' : ''}" ${waiting ? 'data-goto="board"' : ''}><strong>${waiting}</strong> waiting on you</span>
      <span class="chip" ${toMe ? 'data-goto="messages"' : ''}><strong>${toMe}</strong> messages to you (48h)</span>
    </div>
    ${managerPanel()}
    <div id="office-slot"></div>
    <div class="team">${team || '<div class="empty">No agents yet. Add one below.</div>'}</div>
    <div class="actions"><button class="btn" id="new-agent">+ Add agent</button></div>`;
}

function viewBoard() {
  const tasks = visibleTasks();
  const cols = STATUSES.map(([key, label]) => {
    const list = tasks.filter((t) => t.status === key);
    return `<section class="column${key === 'needs_fernando' && list.length ? ' attention' : ''}">
      <h3><span>${label}</span><span>${list.length}</span></h3>
      ${list.map(taskCard).join('') || '<div class="empty small">Nothing here.</div>'}
    </section>`;
  }).join('');
  return `${hint('Every task and where it stands. Leave "Assign to" on "Let the Floor decide" and the Floor Manager gives it to the best-suited free agent, with its reasons. Tap a card to edit, approve or reassign it.')}
    <div class="actions" style="margin:0 0 .75rem"><button class="btn primary" id="new-task">+ New task</button></div>
    ${conflictsPanel()}
    ${managerPanel()}
    <div class="board">${cols}</div>`;
}

function viewFiles() {
  const folders = [['', 'All folders'], ['shared', 'Shared'], ...activeProjects().map((p) => [p.slug, p.name])];
  const files = state.snap.files.filter((f) => !state.folder || f.project === state.folder);
  const rows = files.map((f) => `<tr>
      <td><a href="#" data-file="${f.id}">${esc(f.path)}</a>${f.note ? `<div class="small muted">${esc(f.note)}</div>` : ''}</td>
      <td><span class="pill">${esc(f.project)}</span></td>
      <td class="mono small">v${f.version}</td>
      <td class="mono small">${fmtBytes(f.size_bytes)}</td>
      <td class="small">${esc(agentName(f.updated_by))}<div class="muted">${ago(f.updated_at)}</div></td></tr>`).join('');
  const trash = state.showTrash ? `<div class="panel"><h2>Trash</h2>
      <div class="table-wrap"><table><thead><tr><th>File</th><th>Folder</th><th>Deleted</th><th></th></tr></thead><tbody>
      ${state.snap.trash.map((f) => `<tr><td>${esc(f.path)}</td><td><span class="pill">${esc(f.project)}</span></td>
        <td class="small">${esc(agentName(f.deleted_by))} · ${ago(f.deleted_at)}</td>
        <td><button class="btn small" data-undelete="${f.id}">Restore</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Trash is empty.</td></tr>'}
      </tbody></table></div></div>` : '';
  return `${hint('A shared drive for you and the agents. <strong>Shared</strong> is open to every agent; each project folder is open to that project\'s team. Every save keeps the previous version, and deleted files go to the trash.')}
    <div class="actions" style="margin:0 0 .75rem">
      <select id="folder-filter" aria-label="Folder" style="width:auto">${options(folders, state.folder)}</select>
      <button class="btn primary" id="new-file">+ New file</button>
      <button class="btn" id="upload-file">Upload</button>
      <button class="btn" id="brief-floor">🧠 Brief the Floor</button>
      <input type="file" id="upload-input" class="hidden">
      <label class="inline"><input type="checkbox" id="show-trash"${state.showTrash ? ' checked' : ''}> Show trash</label>
    </div>
    <div class="panel"><div class="table-wrap"><table class="stack compact"><thead><tr><th>File</th><th>Folder</th><th>Version</th><th>Size</th><th>Last saved</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No files yet. Create one, upload one, or let the agents fill it.</td></tr>'}</tbody></table></div></div>
    ${trash}`;
}

function viewVault() {
  const revoked = state.snap.credentials.filter((c) => c.revoked_at).length;
  const rows = state.snap.credentials.filter((c) => state.showRevoked || !c.revoked_at).map((c) => `<tr class="${c.revoked_at ? 'revoked' : ''}">
      <td><strong>${esc(c.name)}</strong>${c.notes ? `<div class="small muted">${esc(c.notes)}</div>` : ''}</td>
      <td class="small">${c.site_url ? `<a href="${esc(c.site_url)}" target="_blank" rel="noopener">${esc(c.site_url.replace(/^https?:\/\//, ''))}</a>` : ''}${c.username ? `<div class="muted">${esc(c.username)}</div>` : ''}</td>
      <td>${c.allowed_agents.length ? c.allowed_agents.map((a) => `<span class="pill who" style="--c:${colorFor(a)}">${esc(agentName(a))}</span>`).join(' ') : '<span class="muted small">nobody yet</span>'}
        <div class="small muted">${c.project ? 'project: ' + esc(c.project) : 'any project'}</div></td>
      <td class="small">${c.revoked_at ? '<span class="pill bad">revoked</span>' : c.last_used_at ? `${esc(agentName(c.last_used_by))} · ${ago(c.last_used_at)}<div class="muted">${c.use_count} use${c.use_count === 1 ? '' : 's'}</div>` : '<span class="muted">never used</span>'}</td>
      <td style="white-space:nowrap"><button class="btn small" data-vault-edit="${esc(c.name)}">${c.revoked_at ? 'Reactivate' : 'Edit'}</button>
        ${c.revoked_at ? '' : `<button class="btn small" data-vault-reveal="${esc(c.name)}">Reveal</button> <button class="btn small danger" data-vault-revoke="${esc(c.name)}">Revoke</button>`}</td></tr>`).join('');
  return `${hint('Logins for low-risk project sites. Secrets are stored encrypted and never shown in the board, only to agents you tick, and every use appears here and in Activity.')}
    <div class="notice small">Use it only for throwaway or project-specific accounts. Never your main email, banking, or a password you use anywhere else.</div>
    <div class="actions" style="margin:0 0 .75rem"><button class="btn primary" id="new-cred">+ Add login</button>
      ${revoked ? `<label class="inline"><input type="checkbox" id="show-revoked"${state.showRevoked ? ' checked' : ''}> Show revoked (${revoked})</label>` : ''}</div>
    <div class="panel"><div class="table-wrap"><table class="stack"><thead><tr><th>Name</th><th>Site</th><th>Who may use it</th><th>Last used</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">The vault is empty.</td></tr>'}</tbody></table></div></div>`;
}

const trophySvg = (c) => `<svg viewBox="0 0 40 48" class="trophy-svg" style="--c:${c}" aria-hidden="true">
  <path class="handle" d="M11 9H6.5a5 5 0 0 0 5.5 8M29 9h4.5a5 5 0 0 1-5.5 8"/>
  <path class="cup" d="M10 5h20v10a10 10 0 0 1-20 0z"/><path class="shine" d="M14.5 8.5v6a5.5 5.5 0 0 0 2.5 4.6"/>
  <rect class="stem" x="18" y="24.5" width="4" height="7"/><rect class="base" x="12.5" y="31" width="15" height="4" rx="1.4"/>
  <rect class="plinth" x="9" y="35" width="22" height="8" rx="2"/></svg>`;
const medalSvg = () => `<svg viewBox="0 0 40 48" class="trophy-svg medal" aria-hidden="true">
  <path class="ribbon" d="M12 2h7l3 14h-7zM28 2h-7l-3 14h7z"/><circle class="disc" cx="20" cy="29" r="12"/>
  <path class="star" d="M20 21.5l2.3 4.7 5.2.8-3.8 3.6.9 5.2-4.6-2.4-4.6 2.4.9-5.2-3.8-3.6 5.2-.8z"/></svg>`;
const weekOf = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };

// Wins as a trophy shelf: one shelf per week, a trophy in the agent's colour for each finished task and a
// gold medal for each achievement. Trophies earned since your last look drop in.
function viewWins() {
  const w = state.snap.wins;
  const seen = Date.parse(recall('wins_seen') || '') || 0;
  remember('wins_seen', new Date().toISOString());
  const board = liveAgents().slice().sort((a, b) => b.tasks_done - a.tasks_done).map((a) => {
    const ach = w.achievements.filter((m) => m.author === a.id).length;
    return `<div class="win-agent" style="--c:${colorFor(a.id)}">${face(a, 'idle', 'mini')}<div><strong>${esc(a.display_name)}</strong>
      <div class="small muted">🏆 ${a.tasks_done} · 🏅 ${ach}</div></div></div>`;
  }).join('');
  const items = [
    ...w.tasks.map((t) => ({ at: t.done_at, html: `<button class="trophy${Date.parse(t.done_at) > seen && seen ? ' fresh' : ''}" data-task="${t.id}" title="${esc(t.ref)} · ${esc(t.title)} (${esc(agentName(t.owner || 'fernando'))})">
        ${trophySvg(colorFor(t.owner || 'fernando'))}<span class="plate">${esc(t.ref)}</span></button>` })),
    ...w.achievements.map((m) => ({ at: m.created_at, html: `<button class="trophy${Date.parse(m.created_at) > seen && seen ? ' fresh' : ''}" data-achievement="${m.id}" title="${esc(agentName(m.author))}: ${esc(m.body)}">
        ${medalSvg()}<span class="plate">${esc(agentName(m.author))}</span></button>` })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
  const weeks = [];
  for (const i of items) {
    const k = weekOf(i.at).getTime();
    if (!weeks.length || weeks[weeks.length - 1].k !== k) weeks.push({ k, items: [] });
    weeks[weeks.length - 1].items.push(i);
  }
  const shelves = weeks.map((wk, n) => `<div class="shelf-row"><div class="shelf-label">${n === 0 && wk.k === weekOf(Date.now()).getTime() ? 'This week' : 'Week of ' + esc(new Date(wk.k).toLocaleDateString([], { month: 'short', day: 'numeric' }))} · ${wk.items.length}</div>
      <div class="shelf">${wk.items.map((i) => i.html).join('')}</div></div>`).join('');
  return `${hint('The trophy shelf: a trophy for every finished task, in the colour of the agent who did it, and a medal for every achievement (last 90 days). Tap one for the details.')}
    <div class="wins-agents">${board}</div>
    <div class="panel cabinet">${shelves || '<div class="empty">The shelf is empty for now. Finished tasks and "achievement" messages show up here.</div>'}</div>`;
}

function viewProjects() {
  return `${hint('Each project has a goal, a Supervisor who does QA, and a team with written role cards. Agents only see projects they belong to.')}
    <div class="actions" style="margin:0 0 .75rem"><button class="btn primary" id="new-project">+ New project</button></div>
    ${state.snap.projects.filter((p) => p.status !== 'archived' || state.project === p.slug).map((p) => {
      const open = state.snap.tasks.filter((t) => t.project_id === p.id && t.status !== 'done').length;
      const team = state.snap.assignments.filter((a) => a.project_id === p.id).map((a) => `<tr>
        <td><span class="pill who" style="--c:${colorFor(a.agent_id)}">${esc(agentName(a.agent_id))}</span></td><td><span class="pill">${esc(a.role)}</span></td>
        <td class="small">${esc(a.scope || '')}</td>
        <td><button class="btn small" data-edit-assignment="${p.slug}|${esc(a.agent_id)}">Role card</button></td></tr>`).join('');
      return `<div class="panel">
        <div class="row-head"><div><h2>${esc(p.name)}</h2>
          <div class="small muted">${esc(p.slug)} · <span class="pill ${p.status === 'active' ? 'ok' : ''}">${esc(p.status)}</span> · Supervisor: <strong>${esc(p.supervisor ? agentName(p.supervisor) : 'none')}</strong> · ${open} open task${open === 1 ? '' : 's'}</div></div>
          <div class="actions" style="margin:0"><button class="btn small" data-edit-project="${p.id}">Edit</button><button class="btn small" data-new-assignment="${p.slug}">+ Add to team</button></div></div>
        ${p.goal ? `<p class="small">${esc(p.goal)}</p>` : ''}
        <div class="table-wrap"><table><thead><tr><th>Agent</th><th>Role</th><th>Scope</th><th></th></tr></thead>
        <tbody>${team || '<tr><td colspan="4" class="muted">Nobody on the team yet.</td></tr>'}</tbody></table></div>
      </div>`;
    }).join('') || '<div class="empty">No projects yet.</div>'}`;
}

function viewMemory() {
  const archived = new Set(state.snap.projects.filter((p) => p.status === 'archived').map((p) => p.slug));
  const list = state.snap.memory.filter((m) => (!state.project || m.project === state.project) && (state.showSuperseded || !m.superseded_by)
    && (!archived.has(m.project) || state.project === m.project));
  const items = list.map((m) => `<div class="list-item${m.superseded_by ? ' superseded' : ''}">
    <div class="small muted">#${m.id} · <span class="pill">${esc(m.kind)}</span> · ${esc(m.project || 'all projects')} · ${esc(agentName(m.author))} · ${stamp(m.created_at)}
      ${m.source_task_id ? ` · from T-${m.source_task_id}` : ''}${m.supersedes ? ` · replaces #${m.supersedes}` : ''}${m.superseded_by ? ` · <strong>superseded by #${m.superseded_by}</strong>` : ''}</div>
    ${m.title ? `<div><strong>${esc(m.title)}</strong></div>` : ''}
    <div>${esc(m.body)}</div>
    ${m.superseded_by ? '' : `<button class="btn small" data-correct-memory="${m.id}" style="margin-top:.35rem">Correct</button>`}
  </div>`).join('');
  return `${hint('Lessons the team keeps so nobody relearns them. Corrections replace an entry but the old one stays on record.')}
    <div class="actions" style="margin:0 0 .75rem">
      <button class="btn primary" id="new-memory">+ Add memory</button>
      <label class="inline"><input type="checkbox" id="show-superseded"${state.showSuperseded ? ' checked' : ''}> Show superseded</label>
    </div>
    <div class="panel">${items || '<div class="empty">No memory yet.</div>'}</div>`;
}

// A "quiet check-in" is the summary an agent posts when it clocks out of a turn in which it did nothing
// else (no claim, task change, file or other message). They are folded so real updates stand out.
function quietCheckins() {
  const ev = state.snap.events; // newest first
  const quiet = new Set();
  ev.forEach((o, i) => {
    if (o.action !== 'clock_out') return;
    // The summary is the broadcast message logged in the same instant as the clock-out.
    const summary = ev.filter((e) => e.actor === o.actor && e.action === 'message' && e.at === o.at);
    if (summary.length !== 1 || !summary[0].detail || summary[0].detail.to) return;
    for (let j = i + 1; j < ev.length; j++) {
      const e = ev[j];
      if (e.actor !== o.actor || e === summary[0]) continue;
      if (e.action === 'clock_in') break;
      return; // the agent did something else this turn
    }
    quiet.add(Number(summary[0].detail.message_id));
  });
  return quiet;
}

function viewMessages() {
  const list = state.snap.messages.filter((m) => !state.project || m.project === state.project);
  const quiet = state.showQuiet ? new Set() : quietCheckins();
  const row = (m) => `<div class="list-item${m.to_agent === 'fernando' ? ' to-me' : ''}">
    <div class="small muted">${stamp(m.created_at)} · <strong>${esc(agentName(m.author))}</strong> → ${esc(m.to_agent ? agentName(m.to_agent) : 'everyone')} · <span class="pill">${esc(m.kind)}</span>
      ${m.project ? ' · ' + esc(m.project) : ''}${m.task_id ? ` · <a href="#" data-task="${m.task_id}">T-${m.task_id}</a>` : ''}</div>
    <div>${esc(m.body)}</div>
  </div>`;
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const who = [...new Set(run.map((m) => agentName(m.author)))].join(', ');
    out.push(`<button class="list-item quiet-run" data-show-quiet>💤 ${run.length} quiet check-in${run.length === 1 ? '' : 's'} <span class="muted">· ${esc(who)} found nothing to do · show</span></button>`);
    run = [];
  };
  for (const m of list) {
    if (quiet.has(m.id)) { run.push(m); continue; }
    flush();
    out.push(row(m));
  }
  flush();
  const n = state.showQuiet ? quietCheckins().size : quiet.size;
  return `${hint('Short notes between turns. Messages to you are marked on the left. Check-ins where an agent found nothing to do are folded.')}
    <div class="actions" style="margin:0 0 .75rem"><button class="btn primary" id="new-message">+ Post message</button>
      ${n ? `<label class="inline"><input type="checkbox" id="show-quiet"${state.showQuiet ? ' checked' : ''}> Show quiet check-ins (${n})</label>` : ''}</div>
    <div class="panel">${out.join('') || '<div class="empty">No messages yet.</div>'}</div>`;
}

function viewActivity() {
  const pById = projectsById();
  const rows = state.snap.events.filter((e) => !state.project || !e.project_id || (pById[e.project_id] || {}).slug === state.project)
    .map((e) => `<tr class="${/credential/.test(e.action) ? 'cred-row' : ''}"><td class="small" style="white-space:nowrap">${stamp(e.at)}</td><td><strong>${esc(agentName(e.actor))}</strong></td>
      <td>${esc(e.action.replace(/_/g, ' '))}${e.task_id ? ` <a href="#" data-task="${e.task_id}">T-${e.task_id}</a>` : ''}${e.detail && (e.detail.path || e.detail.name) ? ` <span class="muted">${esc(e.detail.path || e.detail.name)}</span>` : ''}</td>
      <td class="small muted">${esc(e.via)}</td></tr>`).join('');
  return `${hint('Everything everyone did, newest first (latest 200). This log can\'t be edited or deleted. Vault use is highlighted.')}
    <div class="panel"><div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Via</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function viewSettings() {
  const s = state.snap.settings;
  const sweeps = state.snap.sweeps.map((w) => `<li class="small">${stamp(w.started_at)} by ${esc(w.actor)}: ${esc(JSON.stringify(w.result || {}))}</li>`).join('');
  const retired = state.snap.agents.filter((a) => a.retired_at);
  return `<div class="panel"><h2>House rules</h2>
      <p class="small muted">Every agent reads these at the top of every turn.</p>
      <form id="rules-form"><textarea name="value" rows="14">${esc(s.house_rules || '')}</textarea>
      <div class="actions"><button class="btn primary">Save rules</button></div></form></div>
    <div class="panel"><h2>Connect agents</h2>
      <p class="small">Each agent needs only its board key and the API address. The full guide an agent reads is at
        <a href="${esc(API)}" target="_blank" rel="noopener">${esc(API)}</a>.</p>
      <p class="small"><strong>As a connector (MCP).</strong> In Claude or ChatGPT (developer mode), add a custom connector with the address
        <code>${esc(API)}/mcp/&lt;that agent's board key&gt;</code>. The agent then gets board tools such as board_briefing and board_write_file.
        Treat that address like a password.</p>
      <p class="small muted">Lost a key? Open the agent's Settings on the Floor and choose "Issue new key".</p></div>
    <div class="panel"><h2>🧭 Floor Manager</h2>
      <p class="small muted">Runs inside the database every 10 minutes, and right after you create a task. No AI calls, so it costs nothing.</p>
      <label class="inline"><input type="checkbox" id="mgr-route"${(state.snap.manager || {}).settings && state.snap.manager.settings.auto_route === false ? '' : ' checked'}> Route open work to the best-suited free agent, and move work stuck with an agent who is away</label>
      <label class="inline"><input type="checkbox" id="mgr-effort"${(state.snap.manager || {}).settings && state.snap.manager.settings.auto_effort === false ? '' : ' checked'}> Suggest faster or slower schedules from each agent's workload (you approve each one)</label>
      <div class="actions"><button class="btn" id="save-manager">Save</button><button class="btn" id="run-manager">Run now</button></div></div>
    <div class="panel"><h2>Sweep</h2>
      <p class="small muted">Runs inside the database every 5 minutes: returns stale tasks to Ready, flags duplicates, orphans and long-blocked tasks, and escalates tasks that stay blocked too long to you.</p>
      <form id="hours-form" class="row"><div><label for="hours">Flag a Blocked task after (hours)</label><input id="hours" name="value" type="number" min="1" value="${esc(s.blocked_escalate_hours || '48')}"></div></form>
      <div class="actions"><button class="btn" id="save-hours">Save</button><button class="btn" id="run-sweep">Run sweep now</button></div>
      <ul>${sweeps || '<li class="small muted">No sweeps yet.</li>'}</ul></div>
    ${retired.length ? `<div class="panel"><h2>Retired agents</h2><p class="small muted">Hidden from the Floor. Their history stays.</p>
      ${retired.map((a) => `<div class="list-item"><strong>${esc(a.display_name)}</strong> <span class="muted small">${esc(a.id)}</span>
        <button class="btn small" data-edit-agent="${esc(a.id)}">Settings</button></div>`).join('')}</div>` : ''}
    <div class="panel"><h2>Access</h2>
      <p class="small muted">Your owner token is stored only in this browser. Rotating it signs out every other device.</p>
      <div class="actions"><button class="btn" id="rotate-owner">Rotate my owner token</button><button class="btn danger" id="sign-out">Sign out on this device</button></div></div>`;
}

const VIEWS = { home: () => Home.view(), floor: viewFloor, board: viewBoard, files: viewFiles, vault: viewVault, wins: viewWins, projects: viewProjects, memory: viewMemory, messages: viewMessages, activity: viewActivity, settings: viewSettings };

function render() {
  if (!state.snap) return;
  const sel = $('#project-filter');
  sel.innerHTML = `<option value="">All projects</option>` + activeProjects().map((p) => `<option value="${esc(p.slug)}"${p.slug === state.project ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  const waiting = needsMe();
  $('#needs-me').innerHTML = waiting ? `<a href="#" data-goto="home"><span class="badge">${waiting}</span> need you</a>` : '';
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.view === state.view);
  for (const b of document.querySelectorAll('#bottom-nav [data-goto]')) b.classList.toggle('active', b.dataset.goto === state.view);
  const more = $('#bottom-nav [data-home-nav]');
  if (more) more.classList.toggle('active', !['home', 'floor', 'board', 'messages'].includes(state.view));
  const dot = $('#bottom-nav .bn-count');
  if (dot) { dot.textContent = waiting || ''; dot.classList.toggle('hidden', !waiting); }
  document.body.dataset.view = state.view;
  const scrollY = window.scrollY;
  // A background refresh must not wipe what Fernando is typing: keep edited fields whose saved value is
  // unchanged (for example the house rules while he writes a new one).
  const edits = [...document.querySelectorAll('#view textarea[id], #view input[id], #view form textarea, #view form input')]
    .filter((el) => el.type !== 'checkbox' && el.type !== 'file' && el.value !== el.defaultValue)
    .map((el) => ({ key: el.id || `${el.form && el.form.id}|${el.name}`, value: el.value, saved: el.defaultValue }));
  $('#view').innerHTML = VIEWS[state.view]();
  for (const e of edits) {
    const [formId, name] = e.key.split('|');
    const el = name ? document.querySelector(`#${formId} [name="${name}"]`) : document.getElementById(e.key);
    if (el && el.defaultValue === e.saved) el.value = e.value;
  }
  if (state.view === 'floor' && typeof Office !== 'undefined') Office.attach($('#office-slot'));
  window.scrollTo(0, scrollY);
}

// ---------- tasks ----------

function taskForm(t = {}) {
  const projects = activeProjects();
  const isNew = !t.id;
  return `<form>
    <div class="dialog-error error hidden"></div>
    ${isNew ? '' : `<p class="small muted">${esc(t.ref)} · created by ${esc(agentName(t.created_by))} ${ago(t.created_at)} · ${esc(STATUS_LABEL[t.status])}${t.owner ? ' · held by ' + esc(agentName(t.owner)) : ''}${t.lease_expires_at ? ' · ' + until(t.lease_expires_at) : ''}</p>`}
    ${t.status === 'needs_fernando' ? `<div class="notice"><strong>Waiting on you.</strong> ${t.human_gate ? 'Human gate: ' + esc(t.human_gate) + '. ' : ''}Read the handoff note, then approve or send it back.
      ${t.handoff_note ? `<pre style="margin-top:.5rem">${esc(t.handoff_note)}</pre>` : ''}${t.evidence ? `<div class="small" style="margin-top:.35rem">Evidence: ${esc(t.evidence)}</div>` : ''}
      <div class="actions"><button class="btn primary" value="approve">Approve → Done</button><button class="btn" value="sendback">Send back → Ready</button></div></div>` : ''}
    ${t.route_reason ? `<p class="small route-why">🧭 ${esc(t.route_reason)}</p>` : ''}
    <label for="f-title">Title</label><input id="f-title" name="title" required maxlength="200" value="${esc(t.title || '')}">
    <div class="row">
      <div><label for="f-project">Project</label><select id="f-project" name="project" ${isNew ? '' : 'disabled'}>${options(projects.map((p) => [p.slug, p.name]), t.project || state.project || (projects[0] || {}).slug)}</select></div>
      <div><label for="f-assignee">Assign to</label><select id="f-assignee" name="assignee">${options([['', 'Let the Floor decide'], ...liveAgents().map((a) => [a.id, a.display_name])], t.assignee || '')}</select></div>
      <div><label for="f-role">Role (optional)</label><input id="f-role" name="role_tag" value="${esc(t.role_tag || 'any')}" placeholder="any, researcher, filer..."></div>
    </div>
    <div class="row">
      <div><label for="f-status">Status</label><select id="f-status" name="status">${options(STATUSES.filter(([k]) => k !== 'in_progress' || t.status === 'in_progress').filter(([k]) => !isNew || k === 'ready' || k === 'backlog'), t.status || 'ready')}</select></div>
      <div><label for="f-priority">Priority</label><select id="f-priority" name="priority">${options([[1, 'P1 high'], [2, 'P2 normal'], [3, 'P3 low']], t.priority || 2)}</select></div>
      <div><label for="f-due">Due date</label><input id="f-due" name="due_date" type="date" value="${esc(t.due_date || '')}"></div>
      <div><label for="f-gate">Human gate</label><select id="f-gate" name="human_gate">${options(GATES, t.human_gate || '')}</select></div>
    </div>
    <label>Skills needed <span class="muted">(optional; the Floor guesses from the title if blank)</span></label>${skillChecks(t.skills || [])}
    <label for="f-desc">Description</label><textarea id="f-desc" name="description">${esc(t.description || '')}</textarea>
    <label for="f-next">Next action</label><input id="f-next" name="next_action" value="${esc(t.next_action || '')}">
    <label for="f-deps">Depends on (task ids, comma separated)</label><input id="f-deps" name="depends_on" value="${esc((t.depends_on || []).join(', '))}">
    ${isNew ? '' : `<label for="f-handoff">Handoff note</label><textarea id="f-handoff" name="handoff_note">${esc(t.handoff_note || '')}</textarea>
    <label for="f-evidence">Evidence</label><input id="f-evidence" name="evidence" value="${esc(t.evidence || '')}">`}
    <label for="f-note">Note to post with this change (optional)</label><input id="f-note" name="note" placeholder="Becomes a message on the task">
    <div class="actions"><button class="btn primary" value="save">${isNew ? 'Create task' : 'Save'}</button>${!isNew && ['ready', 'backlog', 'blocked'].includes(t.status) ? '<button class="btn" value="reroute">Let the Floor re-route it</button>' : ''}</div>
    ${isNew ? '' : `<h3 style="margin-top:1.2rem">Messages</h3>${(t.messages || []).map((m) => `<div class="list-item small"><strong>${esc(agentName(m.author))}</strong> → ${esc(m.to_agent ? agentName(m.to_agent) : 'everyone')} · ${stamp(m.created_at)}<br>${esc(m.body)}</div>`).join('') || '<div class="empty small">None.</div>'}
    <h3 style="margin-top:1rem">History</h3>${(t.events || []).map((e) => `<div class="small">${stamp(e.at)} · <strong>${esc(agentName(e.actor))}</strong> ${esc(e.action.replace(/_/g, ' '))}${e.detail && e.detail.to ? ' → ' + esc(e.detail.to) : ''}</div>`).join('')}`}
  </form>`;
}

function taskPayload(f) {
  const p = { ...f };
  p.priority = Number(p.priority);
  p.depends_on = String(p.depends_on || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!p.note) delete p.note;
  return p;
}

async function openTask(id) {
  try {
    const t = await api('task_detail', { id });
    openDialog(`${t.ref} · ${t.title}`, taskForm(t), async (f, action) => {
      const p = taskPayload(f);
      delete p.project;
      p.id = t.id;
      if (action === 'reroute') {
        const r = await act(() => api('route_task', { id: t.id, exclude: t.assignee || '' }));
        flash(`🧭 ${t.ref} → ${agentName(r.to)}: ${(r.why || []).join(', ')}`);
        return;
      }
      if (action === 'approve') p.status = 'done';
      if (action === 'sendback') p.status = 'ready';
      if (p.status === t.status) delete p.status;
      if (p.human_gate === (t.human_gate || '')) delete p.human_gate;
      if (p.assignee === (t.assignee || '')) delete p.assignee;
      await act(() => api('update_task', p), 'Task saved.');
    });
  } catch (e) { flash(e.message, 'error'); }
}

function newTask(preset = {}) {
  if (!activeProjects().length) return flash('Create a project first.', 'error');
  openDialog(preset.assignee ? `New task for ${agentName(preset.assignee)}` : 'New task', taskForm(preset), async (f) => {
    const p = taskPayload(f);
    if (!p.human_gate) delete p.human_gate;
    if (!p.assignee) delete p.assignee;
    const r = await act(() => api('create_task', p), p.assignee ? `Task created for ${agentName(p.assignee)}. They'll pick it up on their next turn.` : 'Task created.');
    if (r && r.routed) flash(`🧭 ${r.ref} → ${agentName(r.routed.to)}: ${(r.routed.why || []).join(', ')}`);
  });
}

// ---------- schedule requests ----------

const applying = new Set();
// Claude's scheduled task is changed from here (Claude Code Remote connector); other agents change their own.
async function applyClaudeSchedule(r) {
  const agent = state.snap.agents.find((a) => a.id === r.agent_id);
  const trigger = r.wake_trigger_id || (agent && agent.wake_trigger_id);
  if (!trigger || applying.has(r.id)) return;
  const every = r.status === 'expired' ? r.prev_every : r.every;
  if (!window.BOARD_SCHEDULE) {
    flash(`Change ${agentName(r.agent_id)}'s scheduled task to "${every}" by hand; this view can't reach the Claude Code Remote connector.`, 'notice');
    return;
  }
  applying.add(r.id);
  try {
    await window.BOARD_SCHEDULE(trigger, every);
    await api('schedule_applied', { id: r.id });
    flash(`${agentName(r.agent_id)} now runs ${every}.`);
    load(true);
  } catch (e) {
    flash(`Couldn't update ${agentName(r.agent_id)}'s scheduled task: ${e.message}`, 'error');
  } finally {
    applying.delete(r.id);
  }
}

// After every refresh: finish any approved or ended change for agents whose schedule lives here.
function syncSchedules() {
  for (const r of state.snap.schedule_requests || []) {
    const agent = state.snap.agents.find((a) => a.id === r.agent_id);
    if ((r.status === 'approved' || r.status === 'expired') && agent && agent.wake_trigger_id) applyClaudeSchedule(r);
  }
}

async function decideSchedule(id, decision, every = '', note = '') {
  try {
    const r = await act(() => api('decide_schedule', { id, decision, every, note }),
      decision === 'approve' ? 'Approved. The agent has been told.' : 'Declined. The agent has been told.');
    if (decision === 'approve' && r && r.wake_trigger_id) await applyClaudeSchedule(r);
  } catch { /* act already flashed */ }
}

function scheduleDialog(id, mode) {
  const r = (state.snap.schedule_requests || []).find((x) => x.id === id);
  if (!r) return;
  openDialog(mode === 'change' ? `Change ${agentName(r.agent_id)}'s schedule` : `Decline ${agentName(r.agent_id)}'s request`, `<form>
    <div class="dialog-error error hidden"></div>
    <p class="small muted">Asked: ${esc(r.every)}${r.until ? ' until ' + esc(stamp(r.until)) : ''} (now ${esc(r.prev_every)}). ${esc(r.reason)}</p>
    ${mode === 'change' ? `<label for="s-every">Run</label><input id="s-every" name="every" value="${esc(r.every)}" placeholder="every 2 hours, once a day, on demand">` : ''}
    <label for="s-note">Note to the agent (optional)</label><input id="s-note" name="note">
    <div class="actions"><button class="btn primary">${mode === 'change' ? 'Approve with this schedule' : 'Decline'}</button></div></form>`,
  (f) => decideSchedule(id, mode === 'change' ? 'approve' : 'decline', f.every || '', f.note || ''));
}

// ---------- floor actions ----------

// Live pings. Claude is woken through claude.ai's Claude Code Remote connector and answers in about a
// minute; other agents can be pinged from their own app with the message ready (ChatGPT opens with it
// typed in). Either way the board relays the reply, and the dashboard checks every few seconds until it lands.
const CHAT_LINKS = { chatgpt: (msg) => `https://chatgpt.com/?q=${encodeURIComponent(msg)}` };
const PING_MESSAGE = 'Company Floor ping from Fernando: use your Company Floor tools now. Call board_briefing, then board_post_message to "fernando" with one line on what you are doing and what is next, then board_clock_out.';
const WAKE_FOR_PING = 'Fernando pinged you from the Company Floor dashboard. Take a short turn now: read your briefing, post a one-line status message to fernando (what you are doing and what is next), then clock out.';
const LIVE_MS = 4 * 60e3;

async function pingAgent(id) {
  try {
    const s = await act(() => api('ping_agent', { agent: id }));
    const [st, label] = agentState(s);
    let how = `Ping sent. ${esc(s.display_name)} will post a status message to you at the start of its next turn.`;
    if (s.wake_trigger_id && window.BOARD_WAKE) {
      try {
        await window.BOARD_WAKE(s.wake_trigger_id, WAKE_FOR_PING);
        how = `⚡ ${esc(s.display_name)} is waking up now. Its reply will appear right here in about a minute.`;
      } catch (e) { how += ` (Couldn't wake it now: ${esc(e.message)})`; }
    } else if (CHAT_LINKS[s.id]) {
      how = `Ping sent. To hear back now, send it the message from its own app; its reply will appear right here:
        <div class="actions"><a class="btn small primary" href="${esc(CHAT_LINKS[s.id](PING_MESSAGE))}" target="_blank" rel="noopener">Open ${esc(s.display_name)} with the message</a>
        <button class="btn small" type="button" data-copy-ping>Copy message</button></div>
        <span class="muted">If its Company Floor connector lives in a desktop app, paste the message there instead.</span>`;
    } else {
      how += ` <button class="btn small" type="button" data-copy-ping>Copy a message to send it yourself</button>`;
    }
    state.live = { agent: s.id, until: Date.now() + LIVE_MS };
    openDialog(`${s.display_name}: status`, `<div class="ping-head" style="--c:${colorFor(s.id)}">${face(s, st)}<div>
        <span class="pill state-${st}">${esc(label)}</span>
        <p class="small">Seen ${ago(s.last_seen_at)} · clocks in ${esc(s.clock_in_every)} · ${s.turns_in_window} turn${s.turns_in_window === 1 ? '' : 's'} in the last ${s.usage_window_hours}h</p></div></div>
      <div class="success small">${how}</div>
      <div id="ping-reply" class="ping-reply"><span class="muted">Waiting for ${esc(s.display_name)}'s reply…</span></div>
      <h3>Working on</h3><p>${s.active_task ? `${esc(s.active_task.ref)} · ${esc(s.active_task.title)} <span class="muted small">(${until(s.active_task.lease_expires_at)})</span>${s.active_task.handoff_note ? `<pre>${esc(s.active_task.handoff_note)}</pre>` : ''}` : '<span class="muted">No task in hand.</span>'}</p>
      <h3>Last report</h3><p>${s.last_summary ? esc(s.last_summary) + ` <span class="muted small">· ${ago(s.last_summary_at)}</span>` : '<span class="muted">No report yet.</span>'}</p>
      <h3>Recent activity</h3>${(s.recent_events || []).map((e) => `<div class="small">${ago(e.at)} · ${esc(e.action.replace(/_/g, ' '))}${e.task_id ? ' T-' + e.task_id : ''}</div>`).join('') || '<div class="small muted">Nothing yet.</div>'}
      <h3>Recent messages</h3>${(s.recent_messages || []).map((m) => `<div class="list-item small">${ago(m.created_at)} → ${esc(m.to_agent ? agentName(m.to_agent) : 'everyone')}: ${esc(m.body)}</div>`).join('') || '<div class="small muted">None.</div>'}`);
  } catch { /* act already flashed */ }
}

async function wakeAgent(id) {
  const a = state.snap.agents.find((x) => x.id === id);
  if (!(await ask(`Start ${a.display_name}'s turn now? It uses your ${a.platform} plan's usage like a scheduled turn.`, 'Wake now'))) return;
  try {
    await window.BOARD_WAKE(a.wake_trigger_id);
    flash(`${a.display_name}'s turn has started. Its report will appear on the Floor when it clocks out.`);
  } catch (e) { flash(e.message, 'error'); }
}

function showKey(agent, key) {
  openDialog(`New board key for ${agent}`, `<div class="success">Copy it now. The board stores only a fingerprint, so it cannot show this key again.</div>
    <pre class="keybox" id="the-key">${esc(key)}</pre>
    <div class="actions"><button class="btn primary" id="copy-key">Copy</button></div>
    <p class="small muted">Paste it into ${esc(agent)}'s scheduled-job instructions, or into its connector address (${esc(API)}/mcp/&lt;key&gt;). The old key has stopped working.</p>`);
  $('#copy-key').addEventListener('click', () => copyText(key, $('#the-key')));
}

function agentDialog(a = {}) {
  openDialog(a.id ? `${a.display_name}: settings` : 'Add agent', `<form>
    <div class="dialog-error error hidden"></div>
    <div class="row">
      <div><label for="a-id">Id</label><input id="a-id" name="id" required pattern="[a-z][a-z0-9_-]{1,31}" value="${esc(a.id || '')}" ${a.id ? 'readonly' : ''}></div>
      <div><label for="a-name">Display name</label><input id="a-name" name="display_name" value="${esc(a.display_name || '')}"></div>
      <div><label for="a-platform">Platform</label><input id="a-platform" name="platform" value="${esc(a.platform || '')}" placeholder="ChatGPT Plus, Gemini free..."></div>
    </div>
    <h3>Schedule and usage</h3>
    <div class="row">
      <div><label for="a-cadence">Clocks in</label><input id="a-cadence" name="clock_in_every" value="${esc(a.clock_in_every || 'every 4 hours')}"></div>
      <div><label for="a-window">Usage window (hours)</label><input id="a-window" name="usage_window_hours" type="number" min="1" max="168" value="${esc(a.usage_window_hours || 5)}"></div>
      <div><label for="a-turns">Turns allowed per window</label><input id="a-turns" name="turn_limit" type="number" min="1" value="${esc(a.turn_limit || '')}" placeholder="blank = no meter"></div>
      <div><label for="a-budget">Token budget</label><input id="a-budget" name="token_budget" value="${esc(a.token_budget || '')}" placeholder="e.g. 2900000000"></div>
    </div>
    <p class="small muted">The platforms don't share their usage with outside apps, so these meters count the turns logged on the board and the tokens agents report when they clock out.</p>
    <label for="a-wake">"Wake now" scheduled task id (Claude only)</label><input id="a-wake" name="wake_trigger_id" value="${esc(a.wake_trigger_id || '')}" placeholder="trig_...">
    ${a.id ? `<h3>Sprite</h3><div class="sprite-row">${face(a, 'idle', 'mini')}<button class="btn small" type="button" data-sprite="${esc(a.id)}">Customize sprite…</button></div>` : ''}
    <h3>Skills and profile</h3>
    <p class="small muted">The Floor Manager routes work by these. Agents keep their own up to date; adjust anything here.</p>
    ${skillChecks(a.skills || [])}
    <label for="a-profile">Profile (strengths and limits)</label><textarea id="a-profile" name="profile" rows="2">${esc(a.profile || '')}</textarea>
    <label for="a-notes">Notes</label><textarea id="a-notes" name="notes" rows="2">${esc(a.notes || '')}</textarea>
    ${a.id ? `<label class="inline"><input type="checkbox" name="retired"${a.retired_at ? ' checked' : ''}> Retired (hide from the Floor; history stays)</label>` : ''}
    <div class="actions"><button class="btn primary" value="save">Save</button>${a.id ? '<button class="btn" value="rotate">Issue new key</button>' : ''}</div>
  </form>`, async (f, action) => {
    if (action === 'rotate' && !(await ask(`Issue a new key for ${a.display_name}? The current key stops working immediately.`, 'Issue new key'))) return 'keep-open';
    await act(() => api('save_agent', f), 'Agent saved.');
    if (action === 'rotate' || !a.id) {
      const r = await api('rotate_agent_key', { agent: f.id });
      setTimeout(() => showKey(f.id, r.key), 0);
    }
  });
}

// ---------- files ----------

const isTextFile = (f) => f.encoding === 'utf8';

async function openFile(id, version) {
  try {
    const f = await api('file_read', { file_id: id, version: version || '' });
    const title = `${f.project}/${f.path}`;
    const meta = `<p class="small muted">Version ${f.version}${f.is_latest ? ' (latest)' : ' (older version)'} · ${fmtBytes(f.size_bytes)} · ${esc(f.mime)} · saved by ${esc(agentName(f.updated_by))} ${ago(f.updated_at)}${f.note ? ' · ' + esc(f.note) : ''}</p>`;
    const tools = `<button class="btn" type="button" data-file-download>Download</button>
      <button class="btn" type="button" data-file-history="${f.id}">History</button>
      ${f.is_latest ? `<button class="btn danger" type="button" data-file-delete="${f.id}">Delete</button>` : `<button class="btn" type="button" data-file-restore="${f.id}|${f.version}">Restore this version</button>`}`;
    if (isTextFile(f)) {
      openDialog(title, `<form>${meta}<div class="dialog-error error hidden"></div>
        <label for="file-body">Content</label><textarea id="file-body" name="content" class="mono editor" rows="16" ${f.is_latest ? '' : 'readonly'}>${esc(f.content)}</textarea>
        ${f.is_latest ? `<label for="file-note">What changed (optional)</label><input id="file-note" name="note">` : ''}
        <div class="actions">${f.is_latest ? '<button class="btn primary" value="save">Save new version</button>' : ''}${tools}</div></form>`,
      async (form) => {
        await act(() => api('file_write', { project: f.project, path: f.path, content: form.content, encoding: 'utf8', mime: f.mime, note: form.note || '' }), 'Saved as a new version.');
      });
    } else {
      openDialog(title, `${meta}<p>This is a binary file. Download it to open it, or upload a replacement with the same name.</p>
        <div class="actions">${tools}<button class="btn" type="button" id="replace-file">Replace</button></div>`);
      $('#replace-file')?.addEventListener('click', () => pickUpload({ project: f.project, path: f.path }));
    }
    $('[data-file-download]')?.addEventListener('click', () => downloadFile(f.path, f.content, f.encoding));
  } catch (e) { flash(e.message, 'error'); }
}

async function fileHistory(id) {
  try {
    const r = await api('file_history', { file_id: id });
    const f = state.snap.files.find((x) => x.id === id) || {};
    openDialog(`History: ${f.path || 'file'}`, `<div class="table-wrap"><table><thead><tr><th>Version</th><th>Saved</th><th>Size</th><th>Note</th><th></th></tr></thead><tbody>
      ${r.versions.map((v) => `<tr><td class="mono">v${v.version}</td><td class="small">${esc(agentName(v.written_by))} · ${stamp(v.written_at)}</td>
        <td class="mono small">${fmtBytes(v.size_bytes)}</td><td class="small">${esc(v.note)}</td>
        <td style="white-space:nowrap"><button class="btn small" data-file-version="${id}|${v.version}">View</button>
        ${v.version !== f.version ? `<button class="btn small" data-file-restore="${id}|${v.version}">Restore</button>` : '<span class="pill ok">current</span>'}</td></tr>`).join('')}
      </tbody></table></div>`);
  } catch (e) { flash(e.message, 'error'); }
}

function newFileDialog() {
  const folders = [['shared', 'Shared (all agents)'], ...activeProjects().map((p) => [p.slug, p.name])];
  openDialog('New file', `<form><div class="dialog-error error hidden"></div>
    <div class="row">
      <div><label for="nf-folder">Folder</label><select id="nf-folder" name="project">${options(folders, state.folder || 'shared')}</select></div>
      <div><label for="nf-path">Name (use / for subfolders)</label><input id="nf-path" name="path" required placeholder="notes/plan.md"></div>
    </div>
    <label for="nf-body">Content</label><textarea id="nf-body" name="content" class="mono editor" rows="14"></textarea>
    <div class="actions"><button class="btn primary">Create file</button></div></form>`,
  async (f) => {
    await act(() => api('file_write', { ...f, encoding: 'utf8' }), 'File created.');
  });
}

let uploadTarget = null;
function pickUpload(target = null) {
  uploadTarget = target;
  $('#upload-input').value = '';
  $('#upload-input').click();
}

async function handleUpload(file) {
  if (!file) return;
  if (file.size > UPLOAD_LIMIT) return flash(`That file is ${fmtBytes(file.size)}. Uploads from here are limited to ${fmtBytes(UPLOAD_LIMIT)}; agents can save files up to 5 MB.`, 'error');
  const asText = TEXT_EXT.test(file.name) || /^text\//.test(file.type) || file.type === 'application/json';
  const content = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('Could not read that file.'));
    r.onload = () => resolve(asText ? r.result : String(r.result).split(',')[1] || '');
    if (asText) r.readAsText(file); else r.readAsDataURL(file);
  });
  const target = uploadTarget && uploadTarget.path ? uploadTarget
    : { project: (uploadTarget && uploadTarget.project) || state.folder || 'shared', path: file.name.replace(/[^A-Za-z0-9._ ()/-]/g, '-') };
  try {
    await act(() => api('file_write', { ...target, content, encoding: asText ? 'utf8' : 'base64', mime: file.type || '', note: `Uploaded ${file.name}` }),
      `${target.path} uploaded.`);
    if ($('#dialog').open) $('#dialog').close();
  } catch { /* flashed */ }
}

// ---------- vault ----------

function credDialog(name) {
  const c = name ? state.snap.credentials.find((x) => x.name === name) : {};
  openDialog(name ? `Vault: ${name}` : 'Add a login', `<form autocomplete="off"><div class="dialog-error error hidden"></div>
    <div class="notice small">Low-risk, project-specific accounts only. The secret is encrypted and only ticked agents can read it.</div>
    <div class="row">
      <div><label for="v-name">Name</label><input id="v-name" name="name" required pattern="[a-z0-9][a-z0-9._-]{1,63}" value="${esc(c.name || '')}" ${name ? 'readonly' : ''} placeholder="github-bot"></div>
      <div><label for="v-site">Site address</label><input id="v-site" name="site_url" value="${esc(c.site_url || '')}" placeholder="https://..."></div>
      <div><label for="v-user">Username or email</label><input id="v-user" name="username" value="${esc(c.username || '')}" autocomplete="off"></div>
    </div>
    <label for="v-secret">${name ? 'New secret (leave blank to keep the current one)' : 'Secret (password, token or API key)'}</label>
    <div class="secret-row"><input id="v-secret" name="secret" type="password" autocomplete="new-password" ${name && !c.revoked_at ? '' : 'required'}>
      <button class="btn small" type="button" id="v-show">Show</button></div>
    <label for="v-project">Project</label><select id="v-project" name="project">${options([['all', 'Any project'], ...activeProjects().map((p) => [p.slug, p.name])], c.project || 'all')}</select>
    <label>Agents allowed to use it</label>
    <div class="checks">${liveAgents().map((a) => `<label class="inline"><input type="checkbox" data-group="allowed_agents" value="${esc(a.id)}"${(c.allowed_agents || []).includes(a.id) ? ' checked' : ''}> ${esc(a.display_name)}</label>`).join('')}</div>
    <label for="v-notes">Notes for the agent (no secrets here)</label><input id="v-notes" name="notes" value="${esc(c.notes || '')}" placeholder="e.g. Use only for posting in the project's test org">
    <div class="actions"><button class="btn primary">Save</button></div></form>`,
  async (f) => {
    if (!f.allowed_agents) f.allowed_agents = [];
    if (!f.secret) delete f.secret;
    await act(() => api('vault_save', f), 'Saved to the vault.');
  });
  $('#v-show').addEventListener('click', () => {
    const i = $('#v-secret');
    i.type = i.type === 'password' ? 'text' : 'password';
    $('#v-show').textContent = i.type === 'password' ? 'Show' : 'Hide';
  });
}

async function revealCred(name) {
  if (!(await ask(`Show the secret for "${name}"? This is logged.`, 'Show secret'))) return;
  try {
    const r = await api('vault_reveal', { name });
    openDialog(`Vault: ${name}`, `<p class="small muted">${esc(r.site_url || '')} ${r.username ? '· ' + esc(r.username) : ''}</p>
      <pre class="keybox" id="the-key">${esc(r.secret)}</pre>
      <div class="actions"><button class="btn primary" id="copy-key">Copy</button></div>`);
    $('#copy-key').addEventListener('click', () => copyText(r.secret, $('#the-key')));
    load(true);
  } catch (e) { flash(e.message, 'error'); }
}

// ---------- projects, memory, messages ----------

function projectDialog(p = {}) {
  openDialog(p.id ? `Edit ${p.name}` : 'New project', `<form>
    <div class="dialog-error error hidden"></div>
    <label for="p-name">Name</label><input id="p-name" name="name" required value="${esc(p.name || '')}">
    ${p.id ? '' : '<label for="p-slug">Short id (optional)</label><input id="p-slug" name="slug" placeholder="made from the name if empty" pattern="[a-z0-9][a-z0-9-]{0,47}">'}
    <label for="p-goal">Goal</label><textarea id="p-goal" name="goal">${esc(p.goal || '')}</textarea>
    <div class="row">
      <div><label for="p-sup">Supervisor</label><select id="p-sup" name="supervisor">${options([['', 'none'], ...liveAgents().map((a) => [a.id, a.display_name])], p.supervisor || '')}</select></div>
      ${p.id ? `<div><label for="p-status">Status</label><select id="p-status" name="status">${options(['active', 'paused', 'archived'], p.status)}</select></div>` : ''}
    </div>
    <label for="p-card">Supervisor card (extra instructions for this project's Supervisor)</label><textarea id="p-card" name="supervisor_card">${esc(p.supervisor_card || '')}</textarea>
    <div class="actions"><button class="btn primary">${p.id ? 'Save' : 'Create project'}</button></div>
  </form>`, async (f) => {
    if (p.id) f.id = p.id;
    await act(() => api('save_project', f), 'Project saved.');
  });
}

function assignmentDialog(slug, agent) {
  const a = state.snap.assignments.find((x) => x.project === slug && x.agent_id === agent) || {};
  openDialog(agent ? `Role card: ${agentName(agent)} on ${slug}` : `Add to ${slug}`, `<form>
    <div class="dialog-error error hidden"></div>
    <div class="row">
      <div><label for="r-agent">Agent</label><select id="r-agent" name="agent" ${agent ? 'disabled' : ''}>${options(liveAgents().map((x) => [x.id, x.display_name]), agent || '')}</select></div>
      <div><label for="r-role">Role</label><input id="r-role" name="role" required value="${esc(a.role || '')}" placeholder="researcher, filer, watcher, bookkeeper, qa"></div>
    </div>
    <label for="r-scope">Project scope</label><textarea id="r-scope" name="scope" rows="2">${esc(a.scope || '')}</textarea>
    <label for="r-tools">Tools allowed</label><textarea id="r-tools" name="tools_allowed" rows="2">${esc(a.tools_allowed || '')}</textarea>
    <label for="r-alone">Can do alone</label><textarea id="r-alone" name="can_do_alone" rows="2">${esc(a.can_do_alone || '')}</textarea>
    <label for="r-approval">Never without approval</label><textarea id="r-approval" name="needs_approval" rows="2">${esc(a.needs_approval || 'Purchases, job offers or contracts: always Fernando.')}</textarea>
    <label for="r-escalate">Escalate when</label><textarea id="r-escalate" name="escalate_when" rows="2">${esc(a.escalate_when || '')}</textarea>
    <div class="actions"><button class="btn primary" value="save">Save role card</button>${agent ? '<button class="btn danger" value="remove">Remove from project</button>' : ''}</div>
  </form>`, async (f, action) => {
    f.project = slug;
    if (agent) f.agent = agent;
    if (action === 'remove') {
      if (!(await ask(`Remove ${agentName(agent)} from ${slug}? Their role card is kept in the record.`, 'Remove'))) return 'keep-open';
      f.remove = true;
    }
    await act(() => api('save_assignment', f), action === 'remove' ? 'Removed.' : 'Role card saved.');
  });
}

function memoryDialog(correcting) {
  const old = correcting ? state.snap.memory.find((m) => m.id === correcting) : null;
  openDialog(old ? `Correct memory #${old.id}` : 'Add memory', `<form>
    <div class="dialog-error error hidden"></div>
    ${old ? `<div class="notice small">The old entry stays in the record, marked superseded. Old text: ${esc(old.body)}</div>` : ''}
    <div class="row">
      <div><label for="m-project">Project</label><select id="m-project" name="project" ${old ? 'disabled' : ''}>${options([['', 'All projects'], ...activeProjects().map((p) => [p.slug, p.name])], old ? old.project || '' : state.project)}</select></div>
      <div><label for="m-kind">Kind</label><select id="m-kind" name="kind">${options(MEMORY_KINDS, old ? old.kind : 'decision')}</select></div>
    </div>
    <label for="m-title">Title</label><input id="m-title" name="title" value="${esc(old ? old.title : '')}">
    <label for="m-body">What the next agent must know</label><textarea id="m-body" name="body" required>${esc(old ? old.body : '')}</textarea>
    <div class="actions"><button class="btn primary">${old ? 'Save correction' : 'Add memory'}</button></div>
  </form>`, async (f) => {
    if (old) { f.supersedes = old.id; f.project = old.project || ''; }
    await act(() => api('add_memory', f), 'Memory saved.');
  });
}

function messageDialog(to = '') {
  openDialog('Post message', `<form>
    <div class="dialog-error error hidden"></div>
    <div class="row">
      <div><label for="g-project">Project</label><select id="g-project" name="project">${options([['', 'Board-wide'], ...activeProjects().map((p) => [p.slug, p.name])], state.project)}</select></div>
      <div><label for="g-to">To</label><select id="g-to" name="to">${options([['', 'Everyone'], ['supervisor', 'Project supervisor'], ...liveAgents().map((a) => [a.id, a.display_name])], to)}</select></div>
      <div><label for="g-kind">Kind</label><select id="g-kind" name="kind">${options(MESSAGE_KINDS, 'update')}</select></div>
    </div>
    <label for="g-body">Message</label><textarea id="g-body" name="body" required maxlength="4000"></textarea>
    <div class="actions"><button class="btn primary">Post</button></div>
  </form>`, async (f) => {
    await act(() => api('post_message', f), 'Posted.');
  });
}

// ---------- "Brief the Floor": bring knowledge in from any AI chat ----------

const briefPrompt = (topic) => `I'm adding what you know to my Company Floor, a shared board where my AI assistants (Claude, ChatGPT, Gemini, Muse) work together. Write a complete handover about ${topic || '[TOPIC]'} that another AI could pick up without asking me anything. Include:
1. What it is and its goal.
2. Current status and latest version, with dates.
3. What is done.
4. What is broken, risky or unresolved.
5. Decisions made, and why.
6. Next steps, in order.
7. Where things live (links, file and folder names, which accounts: names only, never passwords).
8. Anything you are unsure about, clearly marked "unverified".
Do not include passwords, one-time codes, card or account numbers. Reply with one Markdown file named ${(topic || 'topic').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'topic'}-handover.md.`;

function briefDialog() {
  openDialog('🧠 Brief the Floor', `<p class="small">Any AI chat that knows something (your Xglide chat, a ChatGPT conversation, Muse) can brief the whole team:</p>
    <ol class="small"><li>Name the topic, then copy the prompt.</li><li>Paste it into that chat and save its answer as a <code>.md</code> file.</li><li>Upload the file here. Then mention it in a task or a message so an agent reads it.</li></ol>
    <label for="bf-topic">Topic</label><input id="bf-topic" placeholder="e.g. Xglide, from version 0.1.21 to today">
    <textarea id="bf-prompt" rows="10" readonly></textarea>
    <div class="actions"><button class="btn primary" type="button" id="bf-copy">Copy prompt</button><button class="btn" type="button" id="bf-upload">Upload the answer…</button></div>`);
  const fill = () => { $('#bf-prompt').value = briefPrompt($('#bf-topic').value.trim()); };
  fill();
  $('#bf-topic').addEventListener('input', fill);
  $('#bf-copy').addEventListener('click', () => copyText($('#bf-prompt').value, $('#bf-copy')));
  $('#bf-upload').addEventListener('click', () => { $('#dialog').close(); pickUpload({ project: 'shared', path: '' }); });
}

// ---------- "New version available" (website only) ----------
// The Pages build stamps index.html with <meta name="build"> and writes version.json; when they differ
// the page offers a one-tap update. The claude.ai copy is refreshed by reopening it, so this is skipped there.

async function checkVersion() {
  const mine = (document.querySelector('meta[name="build"]') || {}).content;
  if (!mine || mine === 'dev' || window.BOARD_TRANSPORT || !/^https?:/.test(location.protocol)) return;
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const { version } = await r.json();
    if (version && version !== mine && !$('#update-banner')) {
      document.body.insertAdjacentHTML('beforeend', `<div id="update-banner" class="update-banner" role="status">✨ A new version of Company Floor is ready. <button class="btn small primary" id="update-now">Update</button></div>`);
    }
  } catch { /* offline: try again later */ }
}

// ---------- events ----------

document.addEventListener('click', async (ev) => {
  if (Home.click(ev)) return;
  const el = ev.target.closest('a[data-task], .card[data-task], [data-goto], [data-ping], [data-wake], [data-give], [data-edit-project], [data-new-assignment], [data-edit-assignment], [data-toggle-agent], [data-edit-agent], [data-correct-memory], [data-file], [data-file-history], [data-file-version], [data-file-restore], [data-file-delete], [data-undelete], [data-vault-edit], [data-vault-reveal], [data-vault-revoke], [data-copy-ping], [data-conflict], [data-achievement], [data-show-quiet], [data-sprite], [data-sched-approve], [data-sched-change], [data-sched-decline], #run-manager, #save-manager, #brief-floor, #update-now, #new-task, #new-project, #new-agent, #new-memory, #new-message, #new-file, #upload-file, #new-cred, #run-sweep, #save-hours, #rotate-owner, #sign-out');
  if (!el) return;
  const d = el.dataset;
  if (el.tagName === 'A') ev.preventDefault();
  if (d.task) { if ($('#dialog').open) $('#dialog').close(); return openTask(Number(d.task)); }
  if (d.goto) {
    if ($('#dialog').open) $('#dialog').close();
    state.view = d.goto; remember('board_view', state.view); render();
    return window.scrollTo(0, 0);
  }
  if (d.ping) return pingAgent(d.ping);
  if (d.wake) return wakeAgent(d.wake);
  if (d.give) return newTask({ assignee: d.give, role_tag: 'any' });
  if (d.file) return openFile(Number(d.file));
  if (d.fileHistory) return fileHistory(Number(d.fileHistory));
  if (d.fileVersion) { const [id, v] = d.fileVersion.split('|'); return openFile(Number(id), Number(v)); }
  if (d.fileRestore) {
    const [id, v] = d.fileRestore.split('|');
    if (!(await ask(`Make version ${v} the current version? The newer versions stay in the history.`, 'Restore'))) return;
    await act(() => api('file_restore', { file_id: Number(id), version: Number(v) }), `Version ${v} restored as the newest version.`).catch(() => {});
    if ($('#dialog').open) $('#dialog').close();
    return;
  }
  if (d.fileDelete) {
    if (!(await ask('Move this file to the trash? Every version is kept and you can restore it.', 'Move to trash'))) return;
    await act(() => api('file_delete', { file_id: Number(d.fileDelete) }), 'Moved to the trash.').catch(() => {});
    if ($('#dialog').open) $('#dialog').close();
    return;
  }
  if (d.undelete) return act(() => api('file_restore', { file_id: Number(d.undelete) }), 'File restored.').catch(() => {});
  if (el.matches('[data-copy-ping]')) return copyText(PING_MESSAGE, el);
  if (d.conflict) return conflictDialog(Number(d.conflict));
  if (d.achievement) {
    const m = state.snap.wins.achievements.find((x) => String(x.id) === d.achievement);
    if (m) openDialog('🏅 Achievement', `<p>${esc(m.body)}</p><p class="small muted">${esc(agentName(m.author))} · ${stamp(m.created_at)}</p>`);
    return;
  }
  if (el.matches('[data-show-quiet]')) { state.showQuiet = true; return render(); }
  if (d.sprite) {
    if (typeof SpriteMaker === 'undefined') return;
    const a = state.snap.agents.find((x) => x.id === d.sprite);
    return SpriteMaker.open(a, colorFor(a.id), avatarOf(a.id), (image) => act(() => api('save_avatar', { agent: a.id, image }), image ? `${a.display_name} has a new look.` : `${a.display_name} is back to the classic sprite.`));
  }
  if (el.id === 'brief-floor') return briefDialog();
  if (el.id === 'update-now') return location.reload();
  if (d.schedApprove) return decideSchedule(Number(d.schedApprove), 'approve');
  if (d.schedChange) return scheduleDialog(Number(d.schedChange), 'change');
  if (d.schedDecline) return scheduleDialog(Number(d.schedDecline), 'decline');
  if (el.id === 'run-manager') {
    return act(() => api('run_manager')).then((r) => flash(`🧭 Floor Manager: ${r.routed} routed, ${r.rerouted} moved, ${r.schedule_suggestions} schedule suggestion${r.schedule_suggestions === 1 ? '' : 's'}.`)).catch(() => {});
  }
  if (el.id === 'save-manager') {
    return act(() => api('save_manager', { auto_route: $('#mgr-route').checked, auto_effort: $('#mgr-effort').checked }), 'Floor Manager settings saved.').catch(() => {});
  }
  if (d.vaultEdit) return credDialog(d.vaultEdit);
  if (d.vaultReveal) return revealCred(d.vaultReveal);
  if (d.vaultRevoke) {
    if (!(await ask(`Revoke "${d.vaultRevoke}"? The stored secret is wiped and no agent can use it until you save a new one.`, 'Revoke'))) return;
    return act(() => api('vault_revoke', { name: d.vaultRevoke }), 'Revoked and wiped.').catch(() => {});
  }
  if (el.id === 'new-task') return newTask();
  if (el.id === 'new-project') return projectDialog();
  if (el.id === 'new-agent') return agentDialog();
  if (el.id === 'new-memory') return memoryDialog();
  if (el.id === 'new-message') return messageDialog();
  if (el.id === 'new-file') return newFileDialog();
  if (el.id === 'upload-file') return pickUpload();
  if (el.id === 'new-cred') return credDialog();
  if (d.editProject) return projectDialog(state.snap.projects.find((p) => p.id === Number(d.editProject)));
  if (d.newAssignment) return assignmentDialog(d.newAssignment);
  if (d.editAssignment) { const [slug, agent] = d.editAssignment.split('|'); return assignmentDialog(slug, agent); }
  if (d.editAgent) return agentDialog(state.snap.agents.find((a) => a.id === d.editAgent));
  if (d.toggleAgent) {
    const a = state.snap.agents.find((x) => x.id === d.toggleAgent);
    return act(() => api('save_agent', { id: a.id, status: a.status === 'active' ? 'paused' : 'active' }), `${a.display_name} ${a.status === 'active' ? 'paused' : 'resumed'}.`).catch(() => {});
  }
  if (d.correctMemory) return memoryDialog(Number(d.correctMemory));
  if (el.id === 'run-sweep') return act(() => api('run_sweep'), 'Sweep finished.').then((r) => flash('Sweep: ' + JSON.stringify(r))).catch(() => {});
  if (el.id === 'save-hours') return act(() => api('save_setting', { key: 'blocked_escalate_hours', value: $('#hours').value }), 'Saved.').catch(() => {});
  if (el.id === 'rotate-owner') {
    if (!(await ask('Issue a new owner token? Every other device will be signed out.', 'Issue new token'))) return;
    const r = await api('rotate_owner_token', { label: 'dashboard' });
    setToken(r.token);
    openDialog('Your new owner token', `<div class="success">Saved on this device. Keep a copy in a password manager to sign in elsewhere.</div><pre class="keybox" id="the-key">${esc(r.token)}</pre><div class="actions"><button class="btn primary" id="copy-key">Copy</button></div>`);
    $('#copy-key').addEventListener('click', () => copyText(r.token, $('#the-key')));
    return;
  }
  if (el.id === 'sign-out') { setToken(''); location.reload(); }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.matches('.card[data-task]')) openTask(Number(ev.target.dataset.task));
});
document.addEventListener('submit', (ev) => {
  if (ev.target.id === 'rules-form') {
    ev.preventDefault();
    act(() => api('save_setting', { key: 'house_rules', value: formData(ev.target).value }), 'House rules saved.').catch(() => {});
  }
});
document.addEventListener('change', (ev) => {
  const id = ev.target.id;
  if (id === 'show-superseded') { state.showSuperseded = ev.target.checked; render(); }
  if (id === 'show-quiet') { state.showQuiet = ev.target.checked; render(); }
  if (id === 'show-trash') { state.showTrash = ev.target.checked; render(); }
  if (id === 'show-revoked') { state.showRevoked = ev.target.checked; render(); }
  if (id === 'folder-filter') { state.folder = ev.target.value; remember('board_folder', state.folder); render(); }
  if (id === 'upload-input') handleUpload(ev.target.files[0]);
  if (id === 'project-filter') { state.project = ev.target.value; remember('board_project', state.project); render(); }
});
$('#tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('.tab');
  if (!b) return;
  state.view = b.dataset.view;
  remember('board_view', state.view);
  render();
});
$('#refresh').addEventListener('click', () => load());

// ---------- login & polling ----------

function showLogin(msg) {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  const e = $('#login-error');
  if (msg) { e.textContent = msg; e.classList.remove('hidden'); } else e.classList.add('hidden');
}
$('#login-btn').addEventListener('click', async () => {
  setToken($('#token').value.trim());
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await load();
});
$('#token').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-btn').click(); });

// Phones always open on Home, the glanceable page; bigger screens return to the last view.
state.view = matchMedia('(max-width: 700px)').matches ? 'home' : recall('board_view') || 'home';
state.project = recall('board_project');
state.folder = recall('board_folder');
if (!VIEWS[state.view]) state.view = 'home';

if (token()) {
  $('#app').classList.remove('hidden');
  load();
} else {
  showLogin();
}
setInterval(() => { if (document.visibilityState === 'visible' && token() && !$('#dialog').open && !$('#ask').open) load(true); }, 60000);
setInterval(() => { if (state.live && Date.now() < state.live.until && document.visibilityState === 'visible' && token()) load(true); }, 5000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && token()) { load(true); checkVersion(); } });
setInterval(checkVersion, 5 * 60e3);
checkVersion();
