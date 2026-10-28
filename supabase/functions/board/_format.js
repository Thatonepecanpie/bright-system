// Renders the briefing as plain Markdown, which every model reads well.

const when = (s) => (s ? new Date(s).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '');
const PRIORITY = { 1: 'P1 high', 2: 'P2 normal', 3: 'P3 low' };

function taskBlock(t) {
  const lines = [`### ${t.ref} · ${t.title}${t.assigned_to_you ? ' · ASSIGNED TO YOU' : ''}`];
  const meta = [`project: ${t.project}`, `role: ${t.role_tag}`, PRIORITY[t.priority] || `P${t.priority}`, `status: ${t.status}`];
  if (t.owner) meta.push(`owner: ${t.owner}`);
  if (t.assignee && !t.assigned_to_you) meta.push(`assigned to: ${t.assignee}`);
  if (t.due_date) meta.push(`due: ${t.due_date}`);
  if (t.human_gate) meta.push(`HUMAN GATE: ${t.human_gate}`);
  if (t.flags && t.flags.length) meta.push(`flags: ${t.flags.join(', ')}`);
  if (t.lease_expires_at && t.status === 'in_progress') meta.push(`lease ends: ${when(t.lease_expires_at)}`);
  lines.push(meta.join(' · '));
  if (t.assigned_to_you && t.route_reason) lines.push(t.route_reason);
  if (t.description) lines.push('', t.description);
  if (t.next_action) lines.push('', `Next action: ${t.next_action}`);
  if (t.depends_on_open && t.depends_on_open.length) lines.push(`Waiting on: ${t.depends_on_open.join(', ')}`);
  if (t.handoff_note) lines.push('', 'Handoff note so far:', t.handoff_note);
  if (t.evidence) lines.push(`Evidence: ${t.evidence}`);
  return lines.join('\n');
}

export function briefingMarkdown(b, api, agentPage) {
  const out = [];
  out.push(`# Board briefing for ${b.you.name} (${b.you.id})`);
  out.push(`Board time: ${when(b.board_time)} · platform: ${b.you.platform} · expected to clock in: ${b.you.clock_in_every}`);

  out.push('', '## Your move', b.your_move);

  out.push('', '## Your assignments');
  if (!b.assignments.length) out.push('You are not assigned to any active project yet. Post nothing; clock out.');
  for (const a of b.assignments) {
    out.push(`- **${a.project}** (${a.project_name}) · role: ${a.role || 'none'}${a.you_are_supervisor ? ' · **you are the Supervisor**' : ''} · supervisor: ${a.supervisor || 'none'}`);
    if (a.goal) out.push(`  - Goal: ${a.goal}`);
    if (a.scope) out.push(`  - Scope: ${a.scope}`);
    if (a.tools_allowed) out.push(`  - Tools allowed: ${a.tools_allowed}`);
    if (a.can_do_alone) out.push(`  - You may do alone: ${a.can_do_alone}`);
    if (a.needs_approval) out.push(`  - Never without approval: ${a.needs_approval}`);
    if (a.escalate_when) out.push(`  - Escalate when: ${a.escalate_when}`);
    if (a.supervisor_card) out.push(`  - Supervisor card: ${a.supervisor_card}`);
  }

  out.push('', '## Your active task');
  out.push(b.active_task ? taskBlock(b.active_task) : 'None.');

  out.push('', '## Ready tasks you can claim');
  out.push(b.next_tasks.length ? b.next_tasks.map(taskBlock).join('\n\n') : 'None right now.');

  if (b.supervisor) {
    const s = b.supervisor;
    out.push('', '## Supervisor queue');
    const section = (title, list) => {
      out.push('', `### ${title} (${list.length})`);
      if (list.length) out.push(list.map((t) => `- ${t.ref} · ${t.title} · ${t.status}${t.owner ? ' · ' + t.owner : ''}${t.flags.length ? ' · flags: ' + t.flags.join(', ') : ''}${t.handoff_note ? '\n  Handoff: ' + t.handoff_note.replace(/\n/g, ' ') : ''}${t.evidence ? '\n  Evidence: ' + t.evidence : ''}`).join('\n'));
    };
    section('In Review: QA these', s.review);
    section('Blocked', s.blocked);
    section('Flagged by the sweep', s.flagged);
    section('Backlog to triage', s.backlog_to_triage);
    out.push('', `Waiting on Fernando: ${s.needs_fernando_count}`);
  }

  out.push('', '## Shared memory (current entries)');
  out.push(b.memory.length
    ? b.memory.map((m) => `- #${m.id} [${m.kind}] ${m.project || 'all projects'} · ${m.date} · by ${m.author}${m.source_task ? ' · from T-' + m.source_task : ''}${m.supersedes ? ' · replaces #' + m.supersedes : ''}\n  ${m.title ? '**' + m.title + '**: ' : ''}${m.body}`).join('\n')
    : 'Empty.');

  out.push('', '## Messages since your last turn');
  out.push(b.messages.length
    ? b.messages.map((m) => `- [${when(m.at)}] ${m.from} → ${m.to || 'everyone'} (${m.kind}${m.task ? ', ' + m.task : ''}${m.project ? ', ' + m.project : ''}): ${m.body}`).join('\n')
    : 'None.');
  if (b.more_unread_messages) out.push(`(${b.more_unread_messages} more; they will appear next briefing.)`);

  if ((b.conflicts || []).length) {
    out.push('', '## Open conflicts');
    out.push(b.conflicts.map((c) => `- #${c.id} ${c.about} (${c.project || 'board-wide'}${c.task_id ? ', T-' + c.task_id : ''}) · raised by ${c.raised_by} · decides: ${c.decide}\n  A: ${c.source_a}\n  B: ${c.source_b}`).join('\n'));
    out.push(`Supervisors decide: POST ${api}/conflicts/resolve {"id":<id>,"resolution":"..."}`);
  }

  if ((b.routines || []).length) {
    out.push('', '## Routines (recurring work on your projects)');
    out.push(b.routines.map((r) => `- #${r.id} ${r.title} · ${r.project} · ${r.every} · for ${r.assignee || 'whoever the Floor picks'} · ${r.status}${r.status === 'active' ? ' · next ' + when(r.next_at) : ''}${r.last_task ? ` · last copy ${r.last_task.ref} (${r.last_task.status})` : ''}${r.until_note ? ' · until ' + r.until_note : ''}`).join('\n'));
    out.push(`Each copy is an ordinary task: finish it and mark it done; no new copy appears while the last one is open. Propose or change one: POST ${api}/routines {"project":"<slug>","title":"...","every":"once a day","description":"..."}`);
  }

  if (b.profile) {
    out.push('', '## Your skill profile');
    out.push(`Skills: ${(b.profile.skills || []).join(', ') || 'none yet'} · Profile: ${b.profile.profile || 'empty'}`);
    out.push(`Choose from: ${(b.profile.skills_vocab || []).join(', ')}. Update with POST ${api}/profile when it changes.`);
  }
  if (b.schedule) {
    out.push('', '## Your schedule');
    out.push(`The board expects you ${b.schedule.clock_in_every}.`);
    for (const r of b.schedule.requests || []) {
      out.push(`- Request #${r.id}: ${r.every}${r.until ? ' until ' + when(r.until) : ''} · ${r.status}${r.decision_note ? ' · ' + r.decision_note : ''}`);
    }
    out.push(`Need to run more or less often? POST ${api}/schedule-request {"every":"every 2 hours","reason":"...","until":"3 days"}`);
  }

  out.push('', '## Vault entries granted to you');
  out.push((b.credentials_granted || []).length
    ? b.credentials_granted.map((c) => `- ${c.name}${c.site_url ? ' · ' + c.site_url : ''}${c.username ? ' · user ' + c.username : ''}${c.notes ? ' · ' + c.notes : ''}`).join('\n')
      + `\nGet one only when a task needs it: GET ${api}/vault/<name>?task_id=<id>. Never paste it anywhere on the board.`
    : 'None. If a task needs a login, message fernando.');

  out.push('', '## Recent files in the File cabinet');
  out.push((b.recent_files || []).length
    ? b.recent_files.map((f) => `- ${f.project}/${f.path} · v${f.version} · ${f.size_bytes} bytes · by ${f.updated_by} · ${when(f.updated_at)}`).join('\n')
    : 'None yet.');

  out.push('', '## House rules', b.house_rules);

  out.push('', '## How to act',
    `Send your key on every call: Authorization: Bearer <key>. JSON bodies. Full guide: GET ${api}`,
    `- Claim the best task for you: POST ${api}/claim-next`,
    `- Claim a specific task: POST ${api}/tasks/<id>/claim`,
    `- Update your task: POST ${api}/tasks/<id>/update  {"status":"done","handoff_note":"...","evidence":"...","note":"optional message"}`,
    `- Post a message: POST ${api}/messages  {"project":"<slug>","to":"supervisor","kind":"question","body":"..."}`,
    `- Add memory: POST ${api}/memory  {"project":"<slug>","kind":"decision","title":"...","body":"..."}`,
    `- Files: GET ${api}/files · GET ${api}/files/read?project=shared&path=notes/plan.md · POST ${api}/files  {"project":"shared","path":"notes/plan.md","content":"...","note":"what changed"}`,
    `- Clock out: POST ${api}/clock-out  {"summary":"one line on what you did","tokens_used":12345}`,
    agentPage ? `No API access? Use the web page: ${agentPage}` : "");
  return out.join('\n');
}
