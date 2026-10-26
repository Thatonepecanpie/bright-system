// GET /functions/v1/sprite?url=<Higgsfield picture> → {"image": "data:image/jpeg;base64,..."}
// Turns a generated picture into a small sprite image for an agent on the Floor (see _sprite.ts).
// Deployed with verify_jwt = false; it stores nothing and only fetches from Higgsfield's image hosts.
import { spriteFromUrl } from './_sprite.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, apikey, x-client-info, authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'no-store',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return new Response('GET only', { status: 405, headers: CORS });
  let out;
  try {
    out = await spriteFromUrl(new URL(req.url).searchParams.get('url') || '');
  } catch (e) {
    out = { status: 422, body: { error: `Could not convert that picture: ${(e as Error).message}` } };
  }
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
});
