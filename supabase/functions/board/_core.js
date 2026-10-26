// The board's front door, independent of host. Vercel (api/router.js) and the Supabase Edge
// Function (supabase/functions/board) both wrap this. Every rule lives in Postgres
// (supabase/migrations); this only translates friendly REST routes into the two database entry
// points and formats replies. It holds no secret: the Supabase publishable key is public by
// design, and the board keys and owner tokens callers send are checked inside the database.

import { contract } from './_contract.js';
import { briefingMarkdown } from './_format.js';
import { handleMcp } from './_mcp.js';

const json = (status, payload) => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(payload) });
const text = (status, body) => ({ status, type: 'text/plain; charset=utf-8', body });

export async function rpc(cfg, fn, args) {
  const r = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseKey },
    body: JSON.stringify(args),
  });
  const raw = await r.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  if (!r.ok) {
    const status = r.status >= 400 && r.status < 600 ? r.status : 500;
    return { status, error: (data && data.message) || String(raw).slice(0, 500) };
  }
  return { status: 200, data };
}

function credential(headers, body) {
  const m = String(headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  if (headers['x-board-key']) return String(headers['x-board-key']).trim();
  if (body && typeof body === 'object' && body.key) return String(body.key).trim();
  return '';
}

function via(headers) {
  const client = String(headers['x-board-client'] || 'api').slice(0, 20);
  const ua = String(headers['user-agent'] || '').slice(0, 120);
  return ua ? `${client} | ${ua}` : client;
}

// A "key" field is only the caller's credential when no header carries one; otherwise it is data
// (for example save_setting's {"key": "house_rules", "value": ...}) and must reach the database.
function cleanBody(body, headers) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
  if (!/^Bearer\s+\S/i.test(String(headers.authorization || '')) && !headers['x-board-key']) delete b.key;
  return b;
}

/**
 * @param req {method, path, query, headers, body}: path is relative to the API root ("tasks/104/claim");
 *            header names must be lower-case.
 * @param cfg {supabaseUrl, supabaseKey, apiBase, agentPage}
 * @returns {status, type, body}
 */
export async function handle(req, cfg) {
  const { method, query = {}, headers = {} } = req;
  const parts = String(req.path || '').split('/').filter(Boolean);
  const [a, b, c] = parts;
  const body = cleanBody(req.body, headers);

  const agentCall = async (action, args, asText = false) => {
    const key = credential(headers, req.body);
    if (!key) {
      const msg = 'Missing board key. Send "Authorization: Bearer <your board key>".';
      return asText ? text(401, `ERROR 401: ${msg}`) : json(401, { error: msg });
    }
    const r = await rpc(cfg, 'board_agent', { p_key: key, p_action: action, p_args: args, p_via: via(headers) });
    if (r.error) return asText ? text(r.status, `ERROR ${r.status}: ${r.error}`) : json(r.status, { error: r.error });
    return json(200, r.data);
  };

  try {
    if (parts.length === 0 || a === 'help') return text(200, contract(cfg.apiBase, cfg.agentPage));

    if (a === 'health' || (a === 'cron' && b === 'keepalive')) {
      const r = await rpc(cfg, 'board_ping', {});
      return r.error ? json(r.status, { error: r.error }) : json(200, r.data);
    }

    if (a === 'briefing') {
      const wantJson = query.format === 'json';
      const r = await agentCall('briefing', {}, !wantJson);
      if (r.status !== 200 || wantJson) return r;
      return text(200, briefingMarkdown(JSON.parse(r.body), cfg.apiBase, cfg.agentPage));
    }

    if (a === 'tasks' && !b) {
      if (method === 'GET') return agentCall('list_tasks', { project: query.project || '', status: query.status || '' });
      if (method === 'POST') return agentCall('create_task', body);
    }
    if (a === 'tasks' && b) {
      if (!c && method === 'GET') return agentCall('get_task', { id: b });
      if ((!c && (method === 'PATCH' || method === 'POST')) || (c === 'update' && method === 'POST')) {
        return agentCall('update', { ...body, id: b });
      }
      if (c === 'claim' && method === 'POST') return agentCall('claim', { ...body, id: b });
      if (c === 'heartbeat' && method === 'POST') {
        const args = { id: b, lease_minutes: body.lease_minutes };
        if (body.handoff_note !== undefined) args.handoff_note = body.handoff_note;
        if (body.next_action !== undefined) args.next_action = body.next_action;
        return agentCall('update', args);
      }
    }
    if (a === 'claim-next' && method === 'POST') return agentCall('claim_next', body);
    if (a === 'messages' && method === 'POST') return agentCall('post_message', body);
    if (a === 'memory' && method === 'POST') return agentCall('add_memory', body);
    if (a === 'clock-out' && method === 'POST') return agentCall('clock_out', body);

    if (a === 'files') {
      const where = { project: query.project || body.project || '', path: query.path || body.path || '' };
      if (!b && method === 'GET') return agentCall('list_files', { project: query.project || '' });
      if (!b && method === 'POST') return agentCall('write_file', body);
      if (b === 'read' && method === 'GET') return agentCall('read_file', { ...where, version: query.version || '' });
      if (b === 'history' && method === 'GET') return agentCall('file_history', where);
      if (b === 'delete' && method === 'POST') return agentCall('delete_file', where);
    }
    if (a === 'vault') {
      if (!b && method === 'GET') return agentCall('list_credentials', {});
      if (b && (method === 'GET' || method === 'POST')) return agentCall('get_credential', { name: b, task_id: query.task_id || body.task_id || '' });
    }
    if (a === 'schedule-request' && method === 'POST') {
      return agentCall(b === 'done' ? 'confirm_schedule' : 'request_schedule', body);
    }
    if (a === 'profile' && method === 'POST') return agentCall('update_profile', body);
    if (a === 'conflicts' && method === 'POST') {
      return agentCall(b === 'resolve' ? 'resolve_conflict' : 'flag_conflict', body);
    }
    if (a === 'mcp' && b) {
      if (method !== 'POST') return { status: 405, type: 'text/plain; charset=utf-8', body: 'This MCP endpoint takes JSON-RPC over POST.' };
      return handleMcp(req.body, b, cfg, headers);
    }

    if (a === 'owner' && b && method === 'POST') {
      const token = credential(headers, req.body);
      if (!token) return json(401, { error: 'Missing owner token.' });
      const r = await rpc(cfg, 'board_owner', {
        p_token: token, p_action: b.replace(/-/g, '_'), p_args: body, p_via: via(headers),
      });
      return r.error ? json(r.status, { error: r.error }) : json(200, r.data);
    }

    return json(404, { error: `No route for ${method} /${parts.join('/')}. GET ${cfg.apiBase} for the full guide.` });
  } catch (e) {
    return json(500, { error: `Board API error: ${e.message}` });
  }
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Board-Key, X-Board-Client, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Cache-Control': 'no-store',
};
