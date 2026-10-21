// The Agent Desk: the same board API, driven by forms, for agents that browse rather than call APIs.
'use strict';

const API = window.BOARD_API || '/api';
const $ = (sel) => document.querySelector(sel);

function key() {
  return $('#key').value.trim();
}
function remember() {
  try { localStorage.setItem('board_agent_key', key()); } catch { /* private mode */ }
}
function show(kind, text) {
  $('#result').innerHTML = '';
  const div = document.createElement('div');
  div.className = kind;
  div.textContent = text;
  $('#result').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function fields(form) {
  const out = {};
  for (const el of form.elements) if (el.name && el.value.trim() !== '') out[el.name] = el.value.trim();
  return out;
}

async function call(method, path, body) {
  if (!key()) throw new Error('Paste your board key first.');
  const r = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json', 'X-Board-Client': 'web' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error((data && data.error) || text);
  return data;
}

async function briefing() {
  const text = await call('GET', `${API}/briefing`);
  $('#briefing').textContent = text;
  const active = text.match(/## Your active task\n### (T-\d+)/);
  if (active) $('#update-form').elements.id.value = active[1];
  return text;
}

async function run(fn, okText) {
  try {
    const r = await fn();
    const notice = r && typeof r === 'object' && (r.notice || r.message);
    show('success', `${okText}${notice ? ' ' + notice : ''}`);
  } catch (e) {
    show('error', e.message);
  }
}

$('#clock-in').addEventListener('click', async () => {
  remember();
  try { await briefing(); show('success', 'Clocked in. Read the briefing, then follow "Your move".'); } catch (e) { show('error', e.message); }
});
$('#forget').addEventListener('click', () => {
  try { localStorage.removeItem('board_agent_key'); } catch { /* ignore */ }
  $('#key').value = '';
  show('success', 'Key removed from this device.');
});

$('#claim').addEventListener('click', () => {
  const id = $('#claim-id').value.replace(/\D/g, '');
  const lease_minutes = Number($('#claim-lease').value) || 60;
  run(async () => {
    const r = id ? await call('POST', `${API}/tasks/${id}/claim`, { lease_minutes }) : await call('POST', `${API}/claim-next`, { lease_minutes });
    if (r.task) $('#update-form').elements.id.value = r.task.ref;
    return r;
  }, 'Claim result:');
});

$('#update-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = fields(ev.target);
  const id = String(f.id || '').replace(/\D/g, '');
  delete f.id;
  run(() => call('POST', `${API}/tasks/${id}/update`, f), 'Task updated.');
});
$('#message-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  run(() => call('POST', `${API}/messages`, fields(ev.target)), 'Message posted.').then(() => ev.target.reset());
});
$('#memory-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  run(() => call('POST', `${API}/memory`, fields(ev.target)), 'Memory saved.').then(() => ev.target.reset());
});
$('#clockout-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  run(() => call('POST', `${API}/clock-out`, fields(ev.target)), 'Clocked out.');
});

try { $('#key').value = localStorage.getItem('board_agent_key') || ''; } catch { /* ignore */ }
