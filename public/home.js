// Home: the glanceable, phone-first front page. One sentence on how things stand, the few things that
// need Fernando as big cards he can answer with a tap, the team at a glance, and one button to tell
// the team something (the phone keyboard's microphone turns it into dictation). Everything else stays
// one tap away in the full views. Uses app.js globals at call time.
'use strict';

const Home = (() => {
  const DISMISSED = 'home_dismissed';
  const LAST_PROJECT = 'home_project';
  let armed = null; // a quick action waiting for its confirming second tap

  const dismissed = () => new Set(recall(DISMISSED).split(',').filter(Boolean));
  const dismiss = (key) => remember(DISMISSED, [...dismissed(), key].slice(-200).join(','));
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // "~4:55 PM" today, "tomorrow ~2:46 PM", or "Thu ~9:00 AM" further out.
  const when = (ms) => {
    const d = new Date(ms), now = new Date();
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400e3);
    return days === 0 ? `~${clock(ms)}` : days === 1 ? `tomorrow ~${clock(ms)}` : `${d.toLocaleDateString([], { weekday: 'short' })} ~${clock(ms)}`;
  };

  // Questions an agent asked Fernando in the last two days that he hasn't answered or put away here.
  function questions() {
    const gone = dismissed();
    const since = Date.now() - 2 * 86400e3;
    return state.snap.messages.filter((m) => m.to_agent === 'fernando' && m.kind === 'question' && m.author !== 'board'
      && m.author !== 'fernando' && Date.parse(m.created_at) > since && !gone.has(`q${m.id}`)
      && !state.snap.messages.some((r) => r.author === 'fernando' && r.to_agent === m.author && r.id > m.id));
  }

  function needs() {
    const items = [];
    for (const t of state.snap.tasks.filter((x) => x.status === 'needs_fernando')) items.push({ kind: 'task', t });
    for (const r of pendingRequests()) items.push({ kind: 'schedule', r });
    for (const c of openConflicts().filter((x) => x.decide === 'fernando')) items.push({ kind: 'conflict', c });
    for (const r of (state.snap.routines || []).filter((x) => x.status === 'proposed')) items.push({ kind: 'routine', r });
    for (const m of questions()) items.push({ kind: 'question', m });
    return items;
  }

  // When the agent is next expected, from its last visit and how often it clocks in.
  function nextTurn(a) {
    const every = cadenceMs(a.clock_in_every);
    if (!every || !a.last_seen_at || a.status !== 'active') return null;
    return Date.parse(a.last_seen_at) + every;
  }

  function avatar(a, size = '') {
    const pic = avatarOf(a.id);
    return `<span class="h-face ${size}" style="--c:${colorFor(a.id)}">${pic ? `<img src="${pic}" alt="">` : esc(a.display_name.slice(0, 1))}</span>`;
  }

  function headline(items, agents) {
    if (items.length) return `${plural(items.length, 'thing')} ${items.length === 1 ? 'needs' : 'need'} you.`;
    const busy = agents.filter((a) => a.active_task);
    if (busy.length === 1) return `${esc(busy[0].display_name)} is on it.`;
    if (busy.length > 1) return `${busy.length} agents are working.`;
    return 'All quiet.';
  }

  function subline(agents) {
    const soon = agents.map((a) => [a, nextTurn(a)]).filter(([, t]) => t).sort((x, y) => x[1] - y[1]);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const done = state.snap.tasks.filter((t) => t.status === 'done' && Date.parse(t.updated_at) >= today).length;
    const parts = [];
    if (soon.length) {
      const [a, t] = soon.find(([, t]) => t > Date.now()) || soon[0];
      parts.push(t > Date.now() ? `Next check-in: ${esc(a.display_name)}, ${when(t)}.` : `${esc(a.display_name)} is due to check in.`);
    }
    if (done) parts.push(`${plural(done, 'task')} done today.`);
    return parts.join(' ') || 'Nothing scheduled yet.';
  }

  function card(item) {
    if (item.kind === 'task') {
      const t = item.t;
      return `<article class="h-card gate">
        <p class="h-kick">${esc(t.ref)} · ${esc(t.project)}${t.human_gate ? ` · ${esc(t.human_gate.replace(/_/g, ' '))}` : ' · approval'}</p>
        <h3>${esc(t.title)}</h3>
        ${t.handoff_note ? `<p class="h-note">${esc(t.handoff_note)}</p>` : ''}
        <div class="h-acts"><button class="h-btn primary" data-home-act="approve:${t.id}">✓ Approve</button>
          <button class="h-btn" data-home-act="sendback:${t.id}">↩ Send back</button>
          <button class="h-btn ghost" data-task="${t.id}">Details</button></div></article>`;
    }
    if (item.kind === 'schedule') {
      const r = item.r;
      return `<article class="h-card">
        <p class="h-kick">Schedule · ${esc(agentName(r.agent_id))}</p>
        <h3>Run ${esc(r.every)}?</h3>
        <p class="h-note">Now ${esc(r.prev_every)}. ${esc(r.reason)}</p>
        <div class="h-acts"><button class="h-btn primary" data-home-act="sched-ok:${r.id}">✓ Approve</button>
          <button class="h-btn" data-home-act="sched-no:${r.id}">✕ Decline</button></div></article>`;
    }
    if (item.kind === 'routine') {
      const r = item.r;
      return `<article class="h-card">
        <p class="h-kick">🔁 New routine · ${esc(agentName(r.created_by))} asks · ${esc(r.project)}</p>
        <h3>${esc(r.title)}</h3>
        <p class="h-note">${esc(r.every)}${r.assignee ? ` · for ${esc(agentName(r.assignee))}` : ''}${r.until_note ? ` · until ${esc(r.until_note)}` : ''}. ${esc(r.description)}</p>
        <div class="h-acts"><button class="h-btn primary" data-home-act="routine-ok:${r.id}">✓ Start it</button>
          <button class="h-btn" data-home-act="routine-no:${r.id}">✕ Decline</button>
          <button class="h-btn ghost" data-edit-routine="${r.id}">Details</button></div></article>`;
    }
    if (item.kind === 'conflict') {
      const c = item.c;
      return `<article class="h-card">
        <p class="h-kick">Which is right? · ${esc(c.project || 'board-wide')}</p>
        <h3>${esc(c.about)}</h3>
        <div class="h-acts col"><button class="h-btn" data-home-act="pick-a:${c.id}"><b>A</b> ${esc(c.source_a)}</button>
          <button class="h-btn" data-home-act="pick-b:${c.id}"><b>B</b> ${esc(c.source_b)}</button>
          <button class="h-btn ghost" data-conflict="${c.id}">Something else…</button></div></article>`;
    }
    const m = item.m;
    const a = state.snap.agents.find((x) => x.id === m.author) || { id: m.author, display_name: m.author };
    return `<article class="h-card">
      <p class="h-kick">${avatar(a, 'xs')} ${esc(a.display_name)} asks · ${ago(m.created_at)}</p>
      <p class="h-note big">${esc(m.body)}</p>
      <div class="h-acts"><button class="h-btn primary" data-home-reply="${m.id}">Reply</button>
        <button class="h-btn" data-home-act="seen:${m.id}">Got it</button></div></article>`;
  }

  function tile(a) {
    const [st, label] = agentState(a);
    const next = nextTurn(a);
    const what = a.active_task ? `${a.active_task.ref} · ${a.active_task.title}` : a.last_summary || 'No report yet';
    const back = st === 'working' ? 'working now' : next ? (next > Date.now() ? `back ${when(next)}` : 'due now') : esc(a.clock_in_every || '');
    return `<button class="h-tile" data-home-agent="${esc(a.id)}" style="--c:${colorFor(a.id)}">
      ${avatar(a)}<span class="h-tile-text"><span class="h-tile-top"><b>${esc(a.display_name)}</b><span class="h-state st-${st}">${esc(label)}</span></span>
      <span class="h-what">${esc(what)}</span><span class="h-when">${back}</span></span></button>`;
  }

  function feed() {
    const quiet = quietCheckins();
    const agents = new Set(liveAgents().map((a) => a.id));
    return state.snap.messages.filter((m) => agents.has(m.author) && !quiet.has(m.id)).slice(0, 4).map((m) => {
      const a = state.snap.agents.find((x) => x.id === m.author);
      return `<button class="h-feed-row" data-goto="messages">${avatar(a, 'xs')}<span><b>${esc(a.display_name)}</b> <span class="muted">${ago(m.created_at)}${m.to_agent === 'fernando' ? ' · to you' : ''}</span><br>${esc(m.body)}</span></button>`;
    }).join('');
  }

  function view() {
    const items = needs();
    const agents = liveAgents();
    const latest = feed();
    return `<div class="home">
      <header class="h-hero">
        <p class="h-eyebrow">Company Floor · ${clock(Date.now())}</p>
        <h1 class="h-title">${headline(items, agents)}</h1>
        <p class="h-sub">${subline(agents)}</p>
      </header>
      <button class="h-say" data-home-say><span class="h-mic" aria-hidden="true">🎙</span> Tell the team…</button>
      <section class="h-sec">
        <h2>Needs you ${items.length ? `<span class="badge">${items.length}</span>` : ''}</h2>
        ${items.length ? `<div class="h-deck">${items.map(card).join('')}</div>` : '<div class="h-calm">Nothing waiting on you. ✨</div>'}
      </section>
      <section class="h-sec"><h2>Team</h2><div class="h-team">${agents.map(tile).join('')}</div></section>
      ${latest ? `<section class="h-sec"><h2>Latest</h2><div class="h-feed">${latest}</div></section>` : ''}
    </div>`;
  }

  // Quick actions take two taps: the first arms the button, the second (within 4 s) does it.
  function confirmTap(el) {
    if (armed && armed.el === el && Date.now() < armed.until) { armed = null; return true; }
    if (armed) armed.el.classList.remove('armed');
    armed = { el, until: Date.now() + 4000 };
    el.classList.add('armed');
    el.dataset.label = el.dataset.label || el.innerHTML;
    el.textContent = 'Tap again to confirm';
    setTimeout(() => { if (armed && armed.el === el) { armed = null; el.classList.remove('armed'); el.innerHTML = el.dataset.label; } }, 4000);
    return false;
  }

  async function quick(el) {
    const [what, raw] = el.dataset.homeAct.split(':');
    const id = Number(raw);
    if (what === 'seen') { dismiss(`q${id}`); return render(); }
    if (!confirmTap(el)) return;
    if (what === 'approve') return act(() => api('update_task', { id, status: 'done', note: 'Approved from Home.' }), 'Approved.').catch(() => {});
    if (what === 'sendback') return act(() => api('update_task', { id, status: 'ready', note: 'Sent back from Home.' }), 'Sent back to Ready.').catch(() => {});
    if (what === 'sched-ok') return decideSchedule(id, 'approve');
    if (what === 'sched-no') return decideSchedule(id, 'decline');
    if (what === 'routine-ok') return act(() => api('save_routine', { id, status: 'active' }), 'Routine started.').catch(() => {});
    if (what === 'routine-no') return act(() => api('save_routine', { id, status: 'ended' }), 'Routine declined.').catch(() => {});
    if (what === 'pick-a' || what === 'pick-b') {
      const c = openConflicts().find((x) => x.id === id);
      if (!c) return;
      const side = what === 'pick-a' ? ['A', c.source_a] : ['B', c.source_b];
      return act(() => api('resolve_conflict', { id, resolution: `${side[0]} is right: ${side[1]}` }), `Decided: ${side[0]} is right. Saved to Memory.`).catch(() => {});
    }
  }

  // One box for everything Fernando wants to tell the team: a message, a reply, or a new task.
  function say({ to = '', reply = null, task = false } = {}) {
    const projects = activeProjects();
    const lastProject = recall(LAST_PROJECT);
    const project = reply ? reply.project || '' : projects.some((p) => p.slug === lastProject) ? lastProject : (projects[0] || {}).slug || '';
    const who = [['', 'Everyone'], ...liveAgents().map((a) => [a.id, a.display_name])];
    openDialog(reply ? `Reply to ${agentName(reply.author)}` : 'Tell the team', `<form class="h-sayform">
      <div class="dialog-error error hidden"></div>
      ${reply ? `<p class="h-quote">${esc(reply.body)}</p>` : ''}
      <textarea name="body" rows="5" required maxlength="4000" placeholder="Type, or tap the 🎤 on your keyboard and talk." autofocus></textarea>
      ${reply ? `<input type="hidden" name="to" value="${esc(reply.author)}">` : `<div class="h-chips" role="radiogroup" aria-label="To">${who.map(([v, l]) => `<label class="h-chip"><input type="radio" name="to" value="${esc(v)}"${v === to ? ' checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>
      <label class="h-switch"><input type="checkbox" name="task"${task ? ' checked' : ''}><span>Make it a task</span><span class="muted small">the first line becomes its title</span></label>
      <label for="h-repeat" class="small muted">Repeat (tasks only)</label>
      <select id="h-repeat" name="repeat">${options([['', 'Just once'], ...ROUTINE_EVERY], '')}</select>`}
      <label for="h-project" class="small muted">Project</label>
      <select id="h-project" name="project">${options([['', 'Board-wide'], ...projects.map((p) => [p.slug, p.name])], project)}</select>
      <div class="actions"><button class="btn primary h-send">Send</button></div>
    </form>`, async (f) => {
      const body = f.body.trim();
      if (!body) throw new Error('Say something first.');
      if (f.project) remember(LAST_PROJECT, f.project);
      if (f.task) {
        if (!f.project) throw new Error('Pick a project for the task.');
        const title = body.split('\n')[0].slice(0, 120);
        const p = { project: f.project, title, description: body, priority: 2, role_tag: 'any' };
        if (f.to) p.assignee = f.to;
        if (f.repeat) {
          const r = await act(() => api('save_routine', { ...p, every: f.repeat }), `Routine started: a fresh copy ${f.repeat === 'once a day' ? 'every day' : f.repeat}.`);
          if (r && r.last_task) flash(`🔁 First copy: ${r.last_task.ref}`);
          return;
        }
        const r = await act(() => api('create_task', p), f.to ? `Task created for ${agentName(f.to)}.` : 'Task created. The Floor will pick who does it.');
        if (r && r.routed) flash(`🧭 ${r.ref} → ${agentName(r.routed.to)}`);
        return;
      }
      const msg = { body, kind: reply ? 'answer' : 'update' };
      if (f.to) msg.to = f.to;
      if (f.project) msg.project = f.project;
      if (reply && reply.task_id) msg.task_id = reply.task_id;
      await act(() => api('post_message', msg), f.to ? `Sent to ${agentName(f.to)}.` : 'Sent to everyone.');
      if (reply) dismiss(`q${reply.id}`);
    });
  }

  function agentSheet(id) {
    const a = state.snap.agents.find((x) => x.id === id);
    if (!a) return;
    const [st, label] = agentState(a);
    const next = nextTurn(a);
    openDialog(a.display_name, `<div class="h-sheet" style="--c:${colorFor(a.id)}">
      <div class="h-sheet-head">${avatar(a, 'lg')}<div><span class="h-state st-${st}">${esc(label)}</span>
        <p class="small muted">Seen ${ago(a.last_seen_at)} · clocks in ${esc(a.clock_in_every)}${next && next > Date.now() ? ` · back ${when(next)}` : ''}</p></div></div>
      <p>${esc(a.active_task ? `${a.active_task.ref} · ${a.active_task.title}` : a.last_summary || 'No report yet.')}</p>
      <div class="h-big-acts">
        <button class="h-btn primary" data-home-sheet="message:${esc(a.id)}">💬 Message</button>
        <button class="h-btn" data-home-sheet="task:${esc(a.id)}">📌 Give a task</button>
        <button class="h-btn" data-ping="${esc(a.id)}">📡 Ask for a status</button>
        ${a.wake_trigger_id && window.BOARD_WAKE ? `<button class="h-btn" data-wake="${esc(a.id)}">⚡ Wake now</button>` : ''}
        <button class="h-btn ghost" data-sprite="${esc(a.id)}">🎨 Change look</button>
      </div></div>`);
  }

  // Click handling for Home's own controls; returns true when it handled the click.
  function click(ev) {
    const el = ev.target.closest('[data-home-act], [data-home-say], [data-home-agent], [data-home-reply], [data-home-sheet], [data-home-nav]');
    if (!el) return false;
    const d = el.dataset;
    if (d.homeAct) quick(el);
    else if ('homeSay' in d) say();
    else if (d.homeAgent) agentSheet(d.homeAgent);
    else if (d.homeReply) { const m = state.snap.messages.find((x) => x.id === Number(d.homeReply)); if (m) say({ reply: m }); }
    else if (d.homeSheet) { const [what, id] = d.homeSheet.split(':'); say({ to: id, task: what === 'task' }); }
    else if ('homeNav' in d) navSheet();
    return true;
  }

  // The phone tab bar's "More": every other view as a big button.
  function navSheet() {
    const views = [['board', '🗂 Board'], ['files', '📁 Files'], ['vault', '🔐 Vault'], ['wins', '🏆 Wins'], ['projects', '👥 Projects & teams'],
      ['memory', '🧠 Memory'], ['activity', '📜 Activity'], ['settings', '⚙️ Settings']];
    openDialog('Everything else', `<div class="h-big-acts grid">${views.map(([v, l]) => `<button class="h-btn" data-goto="${v}">${l}</button>`).join('')}</div>`);
  }

  return { view, click, say, needs };
})();
