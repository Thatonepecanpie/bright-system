// Turns a generated picture into a sprite image: fetches it (Higgsfield's image hosts only),
// crops the centre square, shrinks it to 192 px and returns a JPEG data URL small enough for
// board.avatars. Public on purpose: it only converts images from those hosts and stores nothing.
import { Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';

const HOSTS = [/^d8j0ntlcm91z4\.cloudfront\.net$/, /(^|\.)higgsfield\.ai$/];
const SIZE = 192;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function spriteFromUrl(raw: string): Promise<{ status: number; body: Record<string, unknown> }> {
  let url: URL;
  try { url = new URL(raw); } catch { return { status: 400, body: { error: 'Give the picture as ?url=https://...' } }; }
  if (url.protocol !== 'https:' || !HOSTS.some((h) => h.test(url.hostname))) {
    return { status: 400, body: { error: 'Only pictures from Higgsfield can be converted here.' } };
  }
  const r = await fetch(url, { redirect: 'error' });
  if (!r.ok) return { status: 502, body: { error: `Could not fetch the picture (${r.status}).` } };
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > 15 * 1024 * 1024) return { status: 413, body: { error: 'That picture is over 15 MB.' } };
  let img = await Image.decode(buf) as Image;
  const side = Math.min(img.width, img.height);
  img = img.crop(Math.floor((img.width - side) / 2), Math.floor((img.height - side) / 2), side, side).resize(SIZE, SIZE);
  for (const q of [88, 75, 60]) {
    const jpg = await img.encodeJPEG(q);
    const data = `data:image/jpeg;base64,${toBase64(jpg)}`;
    if (data.length <= 140000) return { status: 200, body: { image: data, bytes: jpg.length } };
  }
  return { status: 422, body: { error: 'The picture is too detailed to store.' } };
}
