// Supabase Edge Function wrapper around the host-independent API in _core.js.
// _core.js, _format.js and _contract.js here are copies of api/*.js; run `npm run sync-edge` after editing those.
// Deployed with verify_jwt = false: callers authenticate with their board key, checked in the database.

import { handle, CORS } from './_core.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('BOARD_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY')!;
const AGENT_PAGE = Deno.env.get('BOARD_AGENT_PAGE') || '';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1/, '').replace(/^\/board\/?/, '');
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  let body: unknown = undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const raw = await req.text();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
    }
  }

  const out = await handle(
    { method: req.method, path, query: Object.fromEntries(url.searchParams), headers, body },
    { supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, apiBase: `${SUPABASE_URL}/functions/v1/board`, agentPage: AGENT_PAGE },
  );
  return new Response(out.body, { status: out.status, headers: { ...CORS, 'Content-Type': out.type } });
});
