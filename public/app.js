// Fernando's dashboard. Plain JS, no build step. Talks only to /api/owner/*.
'use strict';

const STATUSES = [
  ['backlog', 'Backlog'], ['ready', 'Ready'], ['in_progress', 'In Progress'], ['blocked', 'Blocked'],
  ['needs_fernando', 'Needs Fernando'], ['review', 'Review'], ['done', 'Done'],
];
const STATUS_LABEL = Object.fromEntries(STATUSES);
const GATES = ['', 'purchase', 'job_offer', 'credentials', 'other'];
const MEMORY_KINDS = ['decision', 'rule', 'worked', 'failed', 'fact'];
const MESSAGE_KINDS = ['update', 'question', 'answer', 'feedback', 'blocker', 'achievement'];

const state = { snap: null, view: 'board', project: '', showSuperseded: false };
const $ = (sel, root = document) => root.querySelector(sel);

// ---------- helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 0) return 'in ' + ago(Date.now() - s * 1000).replace(' ago', '');
  if (s < 60) return `${s}s ago`;
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
function flash(msg, kind = 'success') {
  const el = $('#flash');
  el.innerHTML = `<div class="${kind}">${esc(msg)}</div>`;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { el.innerHTML = ''; }, kind === 'error' ? 9000 : 4000);
}
function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

async function api(action, args = {}) {
  const r = await fetch(`/api/owner/${action}`, {
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
    state.snap = await api('snapshot');
    $('#synced').textContent = 'synced ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    render();
  } catch (e) {
    if (e.status === 401) return showLogin('That token was not accepted.');
    if (!quiet) flash(e.message, 'error');
  }
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
        await onSubmit(formData(form), btn && btn.value);
        d.close();
      } catch (e) {
        const box = $('.dialog-error', d);
        if (box) { box.textContent = e.message; box.classList.remove('hidden'); }
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }
  if (!d.open) d.showModal();
  return d;
}
$('#dialog-close').addEventListener('click', () => $('#dialog').close());

// ---------- views ----------

const projectsById = () => Object.fromEntries((state.snap.projects || []).map((p) => [p.id, p]));
const visibleTasks = () => state.snap.tasks.filter((t) => !state.project || t.project === state.project);
const agentIds = () => state.snap.agents.map((a) => a.id);

function taskCard(t) {
  const pills = [];
  if (t.priority === 1) pills.push('<span class="pill p1">P1</span>');
  pills.push(`<span class="pill">${esc(t.role_tag)}</span>`);
  if (t.owner) pills.push(`<span class="pill">${esc(t.owner)}</span>`);
  if (t.human_gate) pills.push(`<span class="pill gate">gate: ${esc(t.human_gate)}</span>`);
  for (const f of t.flags || []) pills.push(`<span class="pill flag">${esc(f.replace(/_/g, ' '))}</span>`);
  if (t.status === 'in_progress' && t.lease_expires_at) pills.push(`<span class="pill">${until(t.lease_expires_at)}</span>`);
  if (t.due_date) pills.push(`<span class="pill">due ${esc(t.due_date)}</span>`);
  if (t.depends_on_open && t.depends_on_open.length) pills.push(`<span class="pill">waits ${esc(t.depends_on_open.join(', '))}</span>`);
  return `<div class="card" data-task="${t.id}">
    <div class="ref">${esc(t.ref)} · ${esc(t.project)}</div>
    <div class="title">${esc(t.title)}</div>
    <div class="meta">${pills.join('')}</div>
  </div>`;
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
  return `<div class="actions" style="margin:0 0 .75rem"><button class="btn primary" id="new-task">+ New task</button></div>
    <div class="board">${cols}</div>`;
}

function viewProjects() {
  const rows = state.snap.projects.map((p) => {
    const open = state.snap.tasks.filter((t) => t.project_id === p.id && t.status !== 'done').length;
    return `<div class="list-item">
      <div style="display:flex;justify-content:space-between;gap:.5rem;flex-wrap:wrap">
        <div><strong>${esc(p.name)}</strong> <span class="pill">${esc(p.slug)}</span> <span class="pill ${p.status === 'active' ? 'ok' : ''}">${esc(p.status)}</span></div>
        <button class="btn small" data-edit-project="${p.id}">Edit</button>
      </div>
      <div class="small muted">Supervisor: ${esc(p.supervisor || 'none')} · ${open} open task(s)</div>
      ${p.goal ? `<div class="small">${esc(p.goal)}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="actions" style="margin:0 0 .75rem"><button class="btn primary" id="new-project">+ New project</button></div>
    <div class="panel">${rows || '<div class="empty">No projects yet.</div>'}</div>`;
}

function viewTeam() {
  const projects = state.snap.projects.filter((p) => p.status !== 'archived' && (!state.project || p.slug === state.project));
  return projects.map((p) => {
    const rows = state.snap.assignments.filter((a) => a.project_id === p.id).map((a) => `<tr>
      <td><strong>${esc(a.agent_id)}</strong></td><td><span class="pill">${esc(a.role)}</span></td>
      <td class="small">${esc(a.scope || '')}</td>
      <td><button class="btn small" data-edit-assignment="${p.slug}|${esc(a.agent_id)}">Role card</button></td></tr>`).join('');
    return `<div class="panel">
      <div style="display:flex;justify-content:space-between;gap:.5rem;flex-wrap:wrap;align-items:center">
        <h2>${esc(p.name)}</h2>
        <button class="btn small" data-new-assignment="${p.slug}">+ Assign agent</button>
      </div>
      <p class="small muted">Supervisor: <strong>${esc(p.supervisor || 'none')}</strong> (change it under Projects). Workers only claim tasks tagged with their role, or tagged "any".</p>
      <div class="table-wrap"><table><thead><tr><th>Agent</th><th>Role</th><th>Scope</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">Nobody assigned yet.</td></tr>'}</tbody></table></div>
    </div>`;
  }).join('') || '<div class="empty">No active projects.</div>';
}

function viewAgents() {
  const rows = state.snap.agents.map((a) => {
    const due = cadenceMs(a.clock_in_every);
    const late = a.status === 'active' && due && a.last_seen_at && Date.now() - new Date(a.last_seen_at).getTime() > due * 1.5;
    return `<tr>
      <td><strong>${esc(a.display_name)}</strong><div class="small muted">${esc(a.id)} · ${esc(a.platform)}</div></td>
      <td><span class="pill ${a.status === 'active' ? 'ok' : 'bad'}">${esc(a.status)}</span></td>
      <td class="small">${esc(a.clock_in_every)}</td>
      <td class="small">${ago(a.last_seen_at)} ${late ? '<span class="pill flag">overdue</span>' : ''}${!a.last_seen_at ? '<span class="pill">not connected yet</span>' : ''}</td>
      <td class="small mono">${a.key_hint ? '…' + esc(a.key_hint) : 'no key'}</td>
      <td style="white-space:nowrap">
        <button class="btn small" data-toggle-agent="${esc(a.id)}">${a.status === 'active' ? 'Pause' : 'Resume'}</button>
        <button class="btn small" data-edit-agent="${esc(a.id)}">Edit</button>
      </td></tr>`;
  }).join('');
  return `<div class="actions" style="margin:0 0 .75rem"><button class="btn primary" id="new-agent">+ Add agent</button></div>
    <div class="panel">
      <p class="small muted">"Clock in every" is the schedule you set in each AI's own scheduled-job settings. The board shows it to the agent and flags it here if the agent is late. Pausing takes effect immediately: a paused agent's key is refused.</p>
      <div class="table-wrap"><table><thead><tr><th>Agent</th><th>Status</th><th>Clock in every</th><th>Last seen</th><th>Key</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
}

function viewMemory() {
  const list = state.snap.memory.filter((m) => (!state.project || m.project === state.project) && (state.showSuperseded || !m.superseded_by));
  const items = list.map((m) => `<div class="list-item${m.superseded_by ? ' superseded' : ''}">
    <div class="small muted">#${m.id} · <span class="pill">${esc(m.kind)}</span> · ${esc(m.project || 'all projects')} · ${esc(m.author)} · ${stamp(m.created_at)}
      ${m.source_task_id ? ` · from T-${m.source_task_id}` : ''}${m.supersedes ? ` · replaces #${m.supersedes}` : ''}${m.superseded_by ? ` · <strong>superseded by #${m.superseded_by}</strong>` : ''}</div>
    ${m.title ? `<div><strong>${esc(m.title)}</strong></div>` : ''}
    <div>${esc(m.body)}</div>
    ${m.superseded_by ? '' : `<button class="btn small" data-correct-memory="${m.id}" style="margin-top:.35rem">Correct</button>`}
  </div>`).join('');
  return `<div class="actions" style="margin:0 0 .75rem">
      <button class="btn primary" id="new-memory">+ Add memory</button>
      <label style="display:flex;gap:.4rem;align-items:center;margin:0"><input type="checkbox" id="show-superseded" style="width:auto"${state.showSuperseded ? ' checked' : ''}> Show superseded</label>
    </div>
    <div class="panel">${items || '<div class="empty">No memory yet. Agents add lessons the next agent would otherwise relearn.</div>'}</div>`;
}

function viewMessages() {
  const list = state.snap.messages.filter((m) => !state.project || m.project === state.project);
  const items = list.map((m) => `<div class="list-item${m.to_agent === 'fernando' ? ' to-me' : ''}">
    <div class="small muted">${stamp(m.created_at)} · <strong>${esc(m.author)}</strong> → ${esc(m.to_agent || 'everyone')} · <span class="pill">${esc(m.kind)}</span>
      ${m.project ? ' · ' + esc(m.project) : ''}${m.task_id ? ` · <a href="#" data-task="${m.task_id}">T-${m.task_id}</a>` : ''}</div>
    <div>${esc(m.body)}</div>
  </div>`).join('');
  return `<div class="actions" style="margin:0 0 .75rem"><button class="btn primary" id="new-message">+ Post message</button></div>
    <div class="panel">${items || '<div class="empty">No messages yet.</div>'}</div>`;
}

function viewActivity() {
  const rows = state.snap.events.filter((e) => !state.project || !e.project_id || (projectsById()[e.project_id] || {}).slug === state.project)
    .map((e) => `<tr><td class="small" style="white-space:nowrap">${stamp(e.at)}</td><td><strong>${esc(e.actor)}</strong></td>
      <td>${esc(e.action.replace(/_/g, ' '))}${e.task_id ? ` <a href="#" data-task="${e.task_id}">T-${e.task_id}</a>` : ''}</td>
      <td class="small muted">${esc(e.via)}</td></tr>`).join('');
  return `<div class="panel"><p class="small muted">Append-only log of everything every agent did (latest 200). Nothing here can be edited or deleted.</p>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Via</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function viewSettings() {
  const s = state.snap.settings;
  const sweeps = state.snap.sweeps.map((w) => `<li class="small">${stamp(w.started_at)} by ${esc(w.actor)}: ${esc(JSON.stringify(w.result || {}))}</li>`).join('');
  return `<div class="panel"><h2>House rules</h2>
      <p class="small muted">Every agent reads these at the top of every turn.</p>
      <form id="rules-form"><textarea name="value" rows="12">${esc(s.house_rules || '')}</textarea>
      <div class="actions"><button class="btn primary">Save rules</button></div></form></div>
    <div class="panel"><h2>Sweep</h2>
      <p class="small muted">Runs inside the database every 5 minutes. It returns stale tasks to Ready, flags duplicates, orphans and long-blocked tasks, and escalates tasks that stay blocked too long to you.</p>
      <form id="hours-form" class="row"><div><label>Flag a Blocked task after (hours)</label><input name="value" type="number" min="1" value="${esc(s.blocked_escalate_hours || '48')}"></div></form>
      <div class="actions"><button class="btn" id="save-hours">Save</button><button class="btn" id="run-sweep">Run sweep now</button></div>
      <ul>${sweeps || '<li class="small muted">No sweeps yet.</li>'}</ul></div>
    <div class="panel"><h2>Access</h2>
      <p class="small muted">Your owner token is stored only in this browser. Rotating it signs out every other device.</p>
      <div class="actions"><button class="btn" id="rotate-owner">Rotate my owner token</button><button class="btn danger" id="sign-out">Sign out on this device</button></div>
      <p class="small muted">Agent page: <a href="/agent">/agent</a> · API guide for agents: <a href="/api">/api</a></p></div>`;
}

const VIEWS = { board: viewBoard, projects: viewProjects, team: viewTeam, agents: viewAgents, memory: viewMemory, messages: viewMessages, activity: viewActivity, settings: viewSettings };

function render() {
  if (!state.snap) return;
  const sel = $('#project-filter');
  const active = state.snap.projects.filter((p) => p.status !== 'archived');
  sel.innerHTML = `<option value="">All projects</option>` + active.map((p) => `<option value="${esc(p.slug)}"${p.slug === state.project ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  const waiting = state.snap.tasks.filter((t) => t.status === 'needs_fernando').length;
  const toMe = state.snap.messages.filter((m) => m.to_agent === 'fernando' && Date.now() - new Date(m.created_at).getTime() < 7 * 86400e3).length;
  $('#needs-me').innerHTML = waiting ? `<span class="badge">${waiting}</span> need you` : (toMe ? `${toMe} message(s) to you this week` : '');
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.view === state.view);
  $('#view').innerHTML = VIEWS[state.view]();
}

// ---------- forms ----------

function taskForm(t = {}) {
  const projects = state.snap.projects.filter((p) => p.status !== 'archived');
  const isNew = !t.id;
  return `<form>
    <div class="dialog-error error hidden"></div>
    ${isNew ? '' : `<p class="small muted">${esc(t.ref)} · created by ${esc(t.created_by)} ${ago(t.created_at)} · status ${esc(STATUS_LABEL[t.status])}${t.owner ? ' · owner ' + esc(t.owner) : ''}${t.lease_expires_at ? ' · lease ' + until(t.lease_expires_at) : ''}</p>`}
    ${t.status === 'needs_fernando' ? `<div class="notice"><strong>Waiting on you.</strong> ${t.human_gate ? 'Human gate: ' + esc(t.human_gate) + '. ' : ''}Read the handoff note, then approve or send it back.</div>` : ''}
    <label>Title</label><input name="title" required maxlength="200" value="${esc(t.title || '')}">
    <div class="row">
      <div><label>Project</label><select name="project" ${isNew ? '' : 'disabled'}>${options(projects.map((p) => [p.slug, p.name]), t.project || state.project || (projects[0] || {}).slug)}</select></div>
      <div><label>Role tag</label><input name="role_tag" value="${esc(t.role_tag || 'any')}" placeholder="any, researcher, filer..."></div>
      <div><label>Priority</label><select name="priority">${options([[1, 'P1 high'], [2, 'P2 normal'], [3, 'P3 low']], t.priority || 2)}</select></div>
    </div>
    <div class="row">
      <div><label>Status</label><select name="status">${options(STATUSES.filter(([k]) => k !== 'in_progress' || t.status === 'in_progress').filter(([k]) => !isNew || k === 'ready' || k === 'backlog'), t.status || 'ready')}</select></div>
      <div><label>Due date</label><input name="due_date" type="date" value="${esc(t.due_date || '')}"></div>
      <div><label>Human gate</label><select name="human_gate">${options(GATES, t.human_gate || '')}</select></div>
    </div>
    <label>Description</label><textarea name="description">${esc(t.description || '')}</textarea>
    <label>Next action</label><input name="next_action" value="${esc(t.next_action || '')}">
    <label>Depends on (task ids, comma separated)</label><input name="depends_on" value="${esc((t.depends_on || []).join(', '))}">
    ${isNew ? '' : `<label>Handoff note</label><textarea name="handoff_note">${esc(t.handoff_note || '')}</textarea>
    <label>Evidence</label><input name="evidence" value="${esc(t.evidence || '')}">`}
    <label>Note to post with this change (optional)</label><input name="note" placeholder="Becomes a message on the task">
    <div class="actions">
      <button class="btn primary" value="save">${isNew ? 'Create task' : 'Save'}</button>
      ${t.status === 'needs_fernando' ? '<button class="btn" value="approve">Approve → Done</button><button class="btn" value="sendback">Send back → Ready</button>' : ''}
    </div>
    ${isNew ? '' : `<h3 style="margin-top:1.2rem">Messages</h3>${(t.messages || []).map((m) => `<div class="list-item small"><strong>${esc(m.author)}</strong> → ${esc(m.to_agent || 'everyone')} · ${stamp(m.created_at)}<br>${esc(m.body)}</div>`).join('') || '<div class="empty small">None.</div>'}
    <h3 style="margin-top:1rem">History</h3>${(t.events || []).map((e) => `<div class="small">${stamp(e.at)} · <strong>${esc(e.actor)}</strong> ${esc(e.action.replace(/_/g, ' '))}${e.detail && e.detail.to ? ' → ' + esc(e.detail.to) : ''}</div>`).join('')}`}
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
      if (action === 'approve') p.status = 'done';
      if (action === 'sendback') p.status = 'ready';
      if (p.status === t.status) delete p.status;
      if (p.human_gate === (t.human_gate || '')) delete p.human_gate;
      await act(() => api('update_task', p), 'Task saved.');
    });
  } catch (e) { flash(e.message, 'error'); }
}

function newTask() {
  if (!state.snap.projects.some((p) => p.status !== 'archived')) return flash('Create a project first.', 'error');
  openDialog('New task', taskForm(), async (f) => {
    const p = taskPayload(f);
    if (!p.human_gate) delete p.human_gate;
    await act(() => api('create_task', p), 'Task created.');
  });
}

function projectDialog(p = {}) {
  openDialog(p.id ? `Edit ${p.name}` : 'New project', `<form>
    <div class="dialog-error error hidden"></div>
    <label>Name</label><input name="name" required value="${esc(p.name || '')}">
    ${p.id ? '' : '<label>Short id (slug, optional)</label><input name="slug" placeholder="made from the name if empty" pattern="[a-z0-9][a-z0-9-]{0,47}">'}
    <label>Goal</label><textarea name="goal">${esc(p.goal || '')}</textarea>
    <div class="row">
      <div><label>Supervisor</label><select name="supervisor">${options(['', ...agentIds()], p.supervisor || '')}</select></div>
      ${p.id ? `<div><label>Status</label><select name="status">${options(['active', 'paused', 'archived'], p.status)}</select></div>` : ''}
    </div>
    <label>Supervisor card (extra instructions for this project's Supervisor)</label><textarea name="supervisor_card">${esc(p.supervisor_card || '')}</textarea>
    <div class="actions"><button class="btn primary">${p.id ? 'Save' : 'Create project'}</button></div>
  </form>`, async (f) => {
    if (p.id) f.id = p.id;
    await act(() => api('save_project', f), 'Project saved.');
  });
}

function assignmentDialog(slug, agent) {
  const a = state.snap.assignments.find((x) => x.project === slug && x.agent_id === agent) || {};
  openDialog(agent ? `Role card: ${agent} on ${slug}` : `Assign an agent to ${slug}`, `<form>
    <div class="dialog-error error hidden"></div>
    <div class="row">
      <div><label>Agent</label><select name="agent" ${agent ? 'disabled' : ''}>${options(agentIds(), agent || '')}</select></div>
      <div><label>Role</label><input name="role" required value="${esc(a.role || '')}" placeholder="researcher, filer, watcher, bookkeeper, qa"></div>
    </div>
    <label>Project scope</label><textarea name="scope" rows="2">${esc(a.scope || '')}</textarea>
    <label>Tools allowed</label><textarea name="tools_allowed" rows="2">${esc(a.tools_allowed || '')}</textarea>
    <label>Can do alone</label><textarea name="can_do_alone" rows="2">${esc(a.can_do_alone || '')}</textarea>
    <label>Never without approval</label><textarea name="needs_approval" rows="2">${esc(a.needs_approval || 'Purchases, job offers or contracts, passwords, one-time codes: always Fernando.')}</textarea>
    <label>Escalate when</label><textarea name="escalate_when" rows="2">${esc(a.escalate_when || '')}</textarea>
    <div class="actions"><button class="btn primary" value="save">Save role card</button>${agent ? '<button class="btn danger" value="remove">Remove from project</button>' : ''}</div>
  </form>`, async (f, action) => {
    f.project = slug;
    if (agent) f.agent = agent;
    if (action === 'remove') {
      if (!confirm(`Remove ${agent} from ${slug}?`)) return;
      f.remove = true;
    }
    await act(() => api('save_assignment', f), action === 'remove' ? 'Removed.' : 'Role card saved.');
  });
}

function showKey(agent, key) {
  openDialog(`New board key for ${agent}`, `<div class="success">Copy it now. The board stores only a fingerprint, so it cannot show this key again.</div>
    <pre class="keybox" id="the-key">${esc(key)}</pre>
    <div class="actions"><button class="btn primary" id="copy-key">Copy</button></div>
    <p class="small muted">Paste it into ${esc(agent)}'s scheduled-job instructions. The old key has stopped working.</p>`);
  $('#copy-key').addEventListener('click', () => navigator.clipboard.writeText(key).then(() => flash('Copied.')));
}

function agentDialog(a = {}) {
  openDialog(a.id ? `Edit ${a.display_name}` : 'Add agent', `<form>
    <div class="dialog-error error hidden"></div>
    <div class="row">
      <div><label>Id</label><input name="id" required pattern="[a-z][a-z0-9_-]{1,31}" value="${esc(a.id || '')}" ${a.id ? 'readonly' : ''}></div>
      <div><label>Display name</label><input name="display_name" value="${esc(a.display_name || '')}"></div>
    </div>
    <div class="row">
      <div><label>Platform</label><input name="platform" value="${esc(a.platform || '')}" placeholder="ChatGPT Plus, Gemini free..."></div>
      <div><label>Clock in every</label><input name="clock_in_every" value="${esc(a.clock_in_every || 'every 4 hours')}"></div>
    </div>
    <label>Notes</label><textarea name="notes" rows="2">${esc(a.notes || '')}</textarea>
    <div class="actions"><button class="btn primary" value="save">Save</button>${a.id ? '<button class="btn" value="rotate">Issue new key</button>' : ''}</div>
  </form>`, async (f, action) => {
    if (action === 'rotate' && !confirm(`Issue a new key for ${a.id}? The current key stops working immediately.`)) return;
    await act(() => api('save_agent', f), 'Agent saved.');
    if (action === 'rotate' || !a.id) {
      const r = await api('rotate_agent_key', { agent: f.id });
      setTimeout(() => showKey(f.id, r.key), 0);
    }
  });
}

function memoryDialog(correcting) {
  const old = correcting ? state.snap.memory.find((m) => m.id === correcting) : null;
  const projects = state.snap.projects.filter((p) => p.status !== 'archived');
  openDialog(old ? `Correct memory #${old.id}` : 'Add memory', `<form>
    <div class="dialog-error error hidden"></div>
    ${old ? `<div class="notice small">The old entry stays in the record, marked superseded. Old text: ${esc(old.body)}</div>` : ''}
    <div class="row">
      <div><label>Project</label><select name="project" ${old ? 'disabled' : ''}>${options([['', 'All projects'], ...projects.map((p) => [p.slug, p.name])], old ? old.project || '' : state.project)}</select></div>
      <div><label>Kind</label><select name="kind">${options(MEMORY_KINDS, old ? old.kind : 'decision')}</select></div>
    </div>
    <label>Title</label><input name="title" value="${esc(old ? old.title : '')}">
    <label>What the next agent must know</label><textarea name="body" required>${esc(old ? old.body : '')}</textarea>
    <div class="actions"><button class="btn primary">${old ? 'Save correction' : 'Add memory'}</button></div>
  </form>`, async (f) => {
    if (old) { f.supersedes = old.id; f.project = old.project || ''; }
    await act(() => api('add_memory', f), 'Memory saved.');
  });
}

function messageDialog() {
  const projects = state.snap.projects.filter((p) => p.status !== 'archived');
  openDialog('Post message', `<form>
    <div class="dialog-error error hidden"></div>
    <div class="row">
      <div><label>Project</label><select name="project">${options([['', 'Board-wide'], ...projects.map((p) => [p.slug, p.name])], state.project)}</select></div>
      <div><label>To</label><select name="to">${options([['', 'Everyone'], ['supervisor', 'Project supervisor'], ...agentIds().map((id) => [id, id])], '')}</select></div>
      <div><label>Kind</label><select name="kind">${options(MESSAGE_KINDS, 'update')}</select></div>
    </div>
    <label>Message</label><textarea name="body" required maxlength="4000"></textarea>
    <div class="actions"><button class="btn primary">Post</button></div>
  </form>`, async (f) => {
    await act(() => api('post_message', f), 'Posted.');
  });
}

// ---------- events ----------

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-task],[data-edit-project],[data-new-assignment],[data-edit-assignment],[data-toggle-agent],[data-edit-agent],[data-correct-memory],#new-task,#new-project,#new-agent,#new-memory,#new-message,#run-sweep,#save-hours,#rotate-owner,#sign-out');
  if (!el || el.closest('dialog') && !el.matches('[data-task]')) return;
  if (el.matches('[data-task]')) { ev.preventDefault(); if ($('#dialog').open) $('#dialog').close(); return openTask(Number(el.dataset.task)); }
  if (el.id === 'new-task') return newTask();
  if (el.id === 'new-project') return projectDialog();
  if (el.id === 'new-agent') return agentDialog();
  if (el.id === 'new-memory') return memoryDialog();
  if (el.id === 'new-message') return messageDialog();
  if (el.dataset.editProject) return projectDialog(state.snap.projects.find((p) => p.id === Number(el.dataset.editProject)));
  if (el.dataset.newAssignment) return assignmentDialog(el.dataset.newAssignment);
  if (el.dataset.editAssignment) { const [slug, agent] = el.dataset.editAssignment.split('|'); return assignmentDialog(slug, agent); }
  if (el.dataset.editAgent) return agentDialog(state.snap.agents.find((a) => a.id === el.dataset.editAgent));
  if (el.dataset.toggleAgent) {
    const a = state.snap.agents.find((x) => x.id === el.dataset.toggleAgent);
    return act(() => api('save_agent', { id: a.id, status: a.status === 'active' ? 'paused' : 'active' }), `${a.display_name} ${a.status === 'active' ? 'paused' : 'resumed'}.`);
  }
  if (el.dataset.correctMemory) return memoryDialog(Number(el.dataset.correctMemory));
  if (el.id === 'run-sweep') return act(() => api('run_sweep'), 'Sweep finished.').then((r) => flash('Sweep: ' + JSON.stringify(r)));
  if (el.id === 'save-hours') return act(() => api('save_setting', { key: 'blocked_escalate_hours', value: formData($('#hours-form')).value }), 'Saved.');
  if (el.id === 'rotate-owner') {
    if (!confirm('Issue a new owner token? Every other device will be signed out.')) return;
    const r = await api('rotate_owner_token', { label: 'dashboard' });
    setToken(r.token);
    openDialog('Your new owner token', `<div class="success">Saved on this device. Store a copy somewhere safe (a password manager) to sign in on other devices.</div><pre class="keybox">${esc(r.token)}</pre>`);
    return;
  }
  if (el.id === 'sign-out') { setToken(''); location.reload(); }
});

document.addEventListener('submit', (ev) => {
  if (ev.target.id === 'rules-form') {
    ev.preventDefault();
    act(() => api('save_setting', { key: 'house_rules', value: formData(ev.target).value }), 'House rules saved.');
  }
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'show-superseded') { state.showSuperseded = ev.target.checked; render(); }
  if (ev.target.id === 'project-filter') {
    state.project = ev.target.value;
    try { localStorage.setItem('board_project', state.project); } catch { /* ignore */ }
    render();
  }
});
$('#tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('.tab');
  if (!b) return;
  state.view = b.dataset.view;
  try { localStorage.setItem('board_view', state.view); } catch { /* ignore */ }
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

try {
  state.view = localStorage.getItem('board_view') || 'board';
  state.project = localStorage.getItem('board_project') || '';
} catch { /* ignore */ }
if (!VIEWS[state.view]) state.view = 'board';

if (token()) {
  $('#app').classList.remove('hidden');
  load();
} else {
  showLogin();
}
setInterval(() => { if (document.visibilityState === 'visible' && token() && !$('#dialog').open) load(true); }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && token()) load(true); });
