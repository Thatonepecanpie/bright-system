// GET /functions/v1/hf-image?url=<Higgsfield result URL> → the original image bytes.
// Lets Claude's sessions (whose network cannot reach Higgsfield's CDN) check generated pictures and
// store them in the File cabinet. Only Higgsfield's own image hosts are fetched, up to 12 MB.
const ALLOWED = /^https:\/\/(d8j0ntlcm91z4\.cloudfront\.net|d2ol7oe51mr4n9\.cloudfront\.net|([a-z0-9-]+\.)*higgsfield\.ai)\//;
const MAX = 12 * 1024 * 1024;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url).searchParams.get('url') || '';
  if (!ALLOWED.test(url)) {
    return new Response(JSON.stringify({ error: 'Only Higgsfield image URLs are accepted.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const r = await fetch(url);
  if (!r.ok) return new Response(JSON.stringify({ error: `Fetch failed: HTTP ${r.status}` }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  const type = r.headers.get('content-type') || 'application/octet-stream';
  if (!/^image\//.test(type)) return new Response(JSON.stringify({ error: 'Not an image.' }), { status: 415, headers: { 'Content-Type': 'application/json' } });
  const body = new Uint8Array(await r.arrayBuffer());
  if (body.length > MAX) return new Response(JSON.stringify({ error: 'Image too large.' }), { status: 413, headers: { 'Content-Type': 'application/json' } });
  return new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
});
