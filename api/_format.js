// Renders the briefing as plain Markdown, which every model reads well.

const when = (s) => (s ? new Date(s).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '');
const PRIORITY = { 1: 'P1 high', 2: 'P2 normal', 3: 'P3 low' };

function taskBlock(t) {
  const lines = [`### ${t.ref} · ${t.title}`];
  const meta = [`project: ${t.project}`, `role: ${t.role_tag}`, PRIORITY[t.priority] || `P${t.priority}`, `status: ${t.status}`];
  if (t.owner) meta.push(`owner: ${t.owner}`);
  if (t.due_date) meta.push(`due: ${t.due_date}`);
  if (t.human_gate) meta.push(`HUMAN GATE: ${t.human_gate}`);
  if (t.flags && t.flags.length) meta.push(`flags: ${t.flags.join(', ')}`);
  if (t.lease_expires_at && t.status === 'in_progress') meta.push(`lease ends: ${when(t.lease_expires_at)}`);
  lines.push(meta.join(' · '));
  if (t.description) lines.push('', t.description);
  if (t.next_action) lines.push('', `Next action: ${t.next_action}`);
  if (t.depends_on_open && t.depends_on_open.length) lines.push(`Waiting on: ${t.depends_on_open.join(', ')}`);
  if (t.handoff_note) lines.push('', 'Handoff note so far:', t.handoff_note);
  if (t.evidence) lines.push(`Evidence: ${t.evidence}`);
  return lines.join('\n');
}

export function briefingMarkdown(b, base) {
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

  out.push('', '## House rules', b.house_rules);

  out.push('', '## How to act',
    `Send your key on every call: Authorization: Bearer <key>. JSON bodies. Full guide: GET ${base}/api`,
    `- Claim the best task for you: POST ${base}/api/claim-next`,
    `- Claim a specific task: POST ${base}/api/tasks/<id>/claim`,
    `- Update your task: POST ${base}/api/tasks/<id>/update  {"status":"done","handoff_note":"...","evidence":"...","note":"optional message"}`,
    `- Post a message: POST ${base}/api/messages  {"project":"<slug>","to":"supervisor","kind":"question","body":"..."}`,
    `- Add memory: POST ${base}/api/memory  {"project":"<slug>","kind":"decision","title":"...","body":"..."}`,
    `- Clock out: POST ${base}/api/clock-out  {"summary":"one line on what you did"}`,
    `No API access? Use the web page: ${base}/agent`);
  return out.join('\n');
}
