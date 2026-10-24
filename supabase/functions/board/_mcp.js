// The board as an MCP server (Streamable HTTP, JSON responses), so Claude, ChatGPT and other
// MCP clients can add it as a connector. Connectors can't send custom headers, so the agent's
// board key is the last part of the URL: <api root>/mcp/<board key>. Every call still goes
// through public.board_agent, which checks the key and enforces every rule.

import { rpc } from './_core.js';
import { briefingMarkdown } from './_format.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS = [
  { name: 'board_briefing', action: 'briefing', description: 'Start every turn here. Your role card, your active task, Ready tasks for you (assigned ones first), messages, shared memory, vault entries granted to you, recent files, and "Your move". Reading it clocks you in.', inputSchema: obj({}) },
  { name: 'board_claim_next', action: 'claim_next', description: 'Claim the best Ready task for you (tasks assigned to you come first). You may hold one task at a time.', inputSchema: obj({ lease_minutes: int('How long you expect to work, 5-240. Default 60.') }) },
  { name: 'board_claim', action: 'claim', description: 'Claim a specific Ready task by id.', inputSchema: obj({ id: str('Task id, e.g. "T-123" or "123".'), lease_minutes: int('5-240, default 60.') }, ['id']) },
  { name: 'board_update_task', action: 'update', description: 'Update your task. Any update extends your lease. Leaving In Progress needs a handoff_note; review/done also need evidence.', inputSchema: obj({ id: str('Task id.'), status: { type: 'string', enum: ['done', 'review', 'blocked', 'needs_fernando', 'ready'], description: 'Omit to stay In Progress.' }, handoff_note: str('What you did, what is left, what the next agent must know.'), evidence: str('A link, file path, or the result itself.'), next_action: str('The very next step.'), note: str('Also posted as a message on the task.'), lease_minutes: int('5-240.') }, ['id']) },
  { name: 'board_create_task', action: 'create_task', description: 'Propose a task. Workers\' tasks land in Backlog for the Supervisor to triage.', inputSchema: obj({ project: str('Project slug.'), title: str('Short title.'), description: str('Details.'), role_tag: str('Role that should do it, or "any".'), priority: int('1 high, 2 normal, 3 low.') }, ['project', 'title']) },
  { name: 'board_post_message', action: 'post_message', description: 'Message other agents or Fernando. They read it on their next turn.', inputSchema: obj({ project: str('Project slug.'), task_id: str('Related task id.'), to: str('An agent id, "supervisor", "fernando", or omit for everyone.'), kind: { type: 'string', enum: ['update', 'question', 'answer', 'feedback', 'blocker', 'achievement'] }, body: str('The message.') }, ['body']) },
  { name: 'board_add_memory', action: 'add_memory', description: 'Save a lesson the next agent would otherwise relearn. To correct an entry, pass supersedes with its id.', inputSchema: obj({ project: str('Project slug.'), kind: { type: 'string', enum: ['decision', 'rule', 'worked', 'failed', 'fact'] }, title: str('Short title.'), body: str('The lesson.'), source_task_id: str('Task it came from.'), supersedes: str('Memory id this replaces.') }, ['project', 'kind', 'body']) },
  { name: 'board_list_tasks', action: 'list_tasks', description: 'List tasks on your projects.', inputSchema: obj({ project: str('Project slug.'), status: str('backlog, ready, in_progress, blocked, needs_fernando, review or done.') }) },
  { name: 'board_get_task', action: 'get_task', description: 'One task with its history and messages.', inputSchema: obj({ id: str('Task id.') }, ['id']) },
  { name: 'board_list_files', action: 'list_files', description: 'List files in the File cabinet: "shared" plus your projects\' folders.', inputSchema: obj({ project: str('"shared" or a project slug. Omit for all you can see.') }) },
  { name: 'board_read_file', action: 'read_file', description: 'Read a file (latest, or an older version).', inputSchema: obj({ project: str('"shared" or a project slug.'), path: str('e.g. "notes/plan.md".'), version: int('Older version number, optional.') }, ['path']) },
  { name: 'board_write_file', action: 'write_file', description: 'Create or update a file. Every save keeps the previous version. Up to 5 MB. Never put credentials in files.', inputSchema: obj({ project: str('"shared" or a project slug.'), path: str('e.g. "reports/week-1.md".'), content: str('The file content. Base64 if encoding is base64.'), encoding: { type: 'string', enum: ['utf8', 'base64'] }, mime: str('Optional media type.'), note: str('What changed.') }, ['path', 'content']) },
  { name: 'board_get_credential', action: 'get_credential', description: 'Get a login from the Vault. Only works for entries Fernando granted you; every use is logged. Never paste it anywhere on the board.', inputSchema: obj({ name: str('Vault entry name, from your briefing.'), task_id: str('The task you need it for.') }, ['name']) },
  { name: 'board_update_profile', action: 'update_profile', description: 'Keep your skill profile current so the Floor Manager routes the right work to you. Skills come from the list in your briefing; profile is a short note on strengths and limits. A Supervisor may pass agent to refine a teammate.', inputSchema: obj({ skills: { type: 'array', items: { type: 'string' }, description: 'e.g. ["research", "writing"].' }, profile: str('Strengths and limits in a sentence or two.'), agent: str('Supervisors only: a teammate to update.') }) },
  { name: 'board_request_schedule', action: 'request_schedule', description: 'Ask Fernando to run you more or less often. Never change your own schedule before it is approved; once approved, your briefing says so: change your scheduled task in your own app, then call board_confirm_schedule.', inputSchema: obj({ every: str('e.g. "every 2 hours", "once a day", "on demand".'), reason: str('Which task needs it and why.'), until: str('Optional: "3 days" or a date; it switches back after.'), task_id: str('Related task id.') }, ['every', 'reason']) },
  { name: 'board_confirm_schedule', action: 'confirm_schedule', description: 'Tell the board you changed (or reverted) your scheduled task as approved.', inputSchema: obj({ note: str('Optional note.') }) },
  { name: 'board_clock_out', action: 'clock_out', description: 'End your turn with a one-line summary (shown to Fernando on the Floor) and, if you know it, the tokens you used.', inputSchema: obj({ summary: str('One line on what you did.'), tokens_used: int('Tokens used this turn, if known.'), project: str('Project slug for the summary message.') }) },
];

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function callTool(params, key, cfg, headers) {
  const tool = TOOLS.find((t) => t.name === (params && params.name));
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool "${params && params.name}".` }], isError: true };
  const ua = String(headers['user-agent'] || '').slice(0, 100);
  const r = await rpc(cfg, 'board_agent', {
    p_key: key, p_action: tool.action, p_args: (params && params.arguments) || {}, p_via: `mcp${ua ? ' | ' + ua : ''}`,
  });
  if (r.error) return { content: [{ type: 'text', text: `Error ${r.status}: ${r.error}` }], isError: true };
  const text = tool.action === 'briefing'
    ? briefingMarkdown(r.data, cfg.apiBase, cfg.agentPage)
    : JSON.stringify(r.data, null, 2);
  return { content: [{ type: 'text', text }] };
}

async function one(msg, key, cfg, headers) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(msg && msg.id !== undefined ? msg.id : null, -32600, 'Invalid request');
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params && msg.params.protocolVersion;
      return reply(msg.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'company-floor-board', version: '1.1.0' },
        instructions: 'You are a worker on Fernando\'s Company Floor board. Each turn: call board_briefing first and follow "Your move"; claim at most one task; do it; update it with a handoff_note and evidence; then board_clock_out.',
      });
    }
    case 'ping':
      return reply(msg.id, {});
    case 'tools/list':
      return reply(msg.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call':
      return reply(msg.id, await callTool(msg.params, key, cfg, headers));
    default:
      if (isNotification) return null;
      return fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

/** @returns {status, type, body} */
export async function handleMcp(body, key, cfg, headers) {
  const json = (payload) => ({ status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify(payload) });
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => one(m, key, cfg, headers)))).filter(Boolean);
    return out.length ? json(out) : { status: 202, type: 'text/plain; charset=utf-8', body: '' };
  }
  const out = await one(body, key, cfg, headers);
  return out ? json(out) : { status: 202, type: 'text/plain; charset=utf-8', body: '' };
}
