// Vercel wrapper around the host-independent API in _core.js.

import { handle, CORS } from './_core.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qwnkqpaloygtgvvwtalu.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_EVO9LZveFZmr8CeILulZag_OMKQNWRa';

function routePath(req) {
  if (typeof req.query.__path === 'string') return req.query.__path;
  if (Array.isArray(req.query.__path)) return req.query.__path.join('/');
  const p = (req.url || '').split('?')[0].replace(/^\/api\/?/, '');
  return p === 'router' ? '' : p;
}

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${host}`;
  const { __path, ...query } = req.query || {};
  void __path;

  const out = await handle(
    { method: req.method, path: routePath(req), query, headers: req.headers, body: req.body },
    { supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, apiBase: `${origin}/api`, agentPage: `${origin}/agent` },
  );
  res.setHeader('Content-Type', out.type);
  res.status(out.status).send(out.body);
}
