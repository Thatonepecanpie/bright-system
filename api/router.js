// The board's front door. Every rule lives in Postgres (supabase/migrations); this file only
// translates friendly REST routes into the two database entry points and formats replies.
// It holds no secret: the Supabase publishable key is public by design, and the board keys
// and owner token that callers send are checked inside the database.

import { contract } from './_contract.js';
import { briefingMarkdown } from './_format.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qwnkqpaloygtgvvwtalu.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_EVO9LZveFZmr8CeILulZag_OMKQNWRa';

async function rpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) {
    const status = r.status >= 400 && r.status < 600 ? r.status : 500;
    return { status, error: (data && data.message) || String(text).slice(0, 500) };
  }
  return { status: 200, data };
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  if (req.headers['x-board-key']) return String(req.headers['x-board-key']).trim();
  if (req.body && typeof req.body === 'object' && req.body.key) return String(req.body.key).trim();
  return '';
}

function via(req) {
  const client = String(req.headers['x-board-client'] || 'api').slice(0, 20);
  const ua = String(req.headers['user-agent'] || '').slice(0, 120);
  return ua ? `${client} | ${ua}` : client;
}

function body(req) {
  const b = req.body && typeof req.body === 'object' ? { ...req.body } : {};
  delete b.key;
  return b;
}

function baseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

function routePath(req) {
  if (typeof req.query.__path === 'string') return req.query.__path;
  if (Array.isArray(req.query.__path)) return req.query.__path.join('/');
  const p = (req.url || '').split('?')[0].replace(/^\/api\/?/, '');
  return p === 'router' ? '' : p;
}

function send(res, status, payload, asText = false) {
  if (asText) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(status).send(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
  } else {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(status).send(JSON.stringify(payload));
  }
}

async function agentCall(req, res, action, args, asText = false) {
  const key = bearer(req);
  if (!key) {
    return send(res, 401, { error: 'Missing board key. Send "Authorization: Bearer <your board key>".' }, asText);
  }
  const r = await rpc('board_agent', { p_key: key, p_action: action, p_args: args, p_via: via(req) });
  if (r.error) return send(res, r.status, asText ? `ERROR ${r.status}: ${r.error}` : { error: r.error }, asText);
  return send(res, 200, r.data, asText);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Board-Key, X-Board-Client');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const parts = routePath(req).split('/').filter(Boolean);
  const [a, b, c] = parts;
  const m = req.method;

  try {
    if (parts.length === 0 || a === 'help') return send(res, 200, contract(baseUrl(req)), true);

    if (a === 'health' || (a === 'cron' && b === 'keepalive')) {
      const r = await rpc('board_ping', {});
      return send(res, r.error ? r.status : 200, r.error ? { error: r.error } : r.data);
    }

    if (a === 'briefing') {
      const wantJson = req.query.format === 'json';
      const key = bearer(req);
      if (!key) return send(res, 401, wantJson ? { error: 'Missing board key.' } : 'ERROR 401: Missing board key. Send "Authorization: Bearer <your board key>".', !wantJson);
      const r = await rpc('board_agent', { p_key: key, p_action: 'briefing', p_args: {}, p_via: via(req) });
      if (r.error) return send(res, r.status, wantJson ? { error: r.error } : `ERROR ${r.status}: ${r.error}`, !wantJson);
      return wantJson ? send(res, 200, r.data) : send(res, 200, briefingMarkdown(r.data, baseUrl(req)), true);
    }

    if (a === 'tasks' && !b) {
      if (m === 'GET') return agentCall(req, res, 'list_tasks', { project: req.query.project || '', status: req.query.status || '' });
      if (m === 'POST') return agentCall(req, res, 'create_task', body(req));
    }
    if (a === 'tasks' && b) {
      if (!c && m === 'GET') return agentCall(req, res, 'get_task', { id: b });
      if ((!c && (m === 'PATCH' || m === 'POST')) || (c === 'update' && m === 'POST')) {
        return agentCall(req, res, 'update', { ...body(req), id: b });
      }
      if (c === 'claim' && m === 'POST') return agentCall(req, res, 'claim', { ...body(req), id: b });
      if (c === 'heartbeat' && m === 'POST') {
        const { lease_minutes, handoff_note, next_action } = body(req);
        const args = { id: b, lease_minutes };
        if (handoff_note !== undefined) args.handoff_note = handoff_note;
        if (next_action !== undefined) args.next_action = next_action;
        return agentCall(req, res, 'update', args);
      }
    }
    if (a === 'claim-next' && m === 'POST') return agentCall(req, res, 'claim_next', body(req));
    if (a === 'messages' && m === 'POST') return agentCall(req, res, 'post_message', body(req));
    if (a === 'memory' && m === 'POST') return agentCall(req, res, 'add_memory', body(req));
    if (a === 'clock-out' && m === 'POST') return agentCall(req, res, 'clock_out', body(req));

    if (a === 'owner' && b && m === 'POST') {
      const token = bearer(req);
      if (!token) return send(res, 401, { error: 'Missing owner token.' });
      const r = await rpc('board_owner', {
        p_token: token, p_action: b.replace(/-/g, '_'), p_args: body(req), p_via: via(req),
      });
      return send(res, r.error ? r.status : 200, r.error ? { error: r.error } : r.data);
    }

    return send(res, 404, { error: `No route for ${m} /api/${parts.join('/')}. GET /api for the full guide.` });
  } catch (e) {
    return send(res, 500, { error: `Board API error: ${e.message}` });
  }
}
