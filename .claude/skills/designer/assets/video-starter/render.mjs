// Render a Remotion composition to MP4 plus a still, headless, in a cloud session.
// Usage: node render.mjs [compositionId=Promo] [stillFrame=75]
// Verified 2026-11-06: 1280x720, 90 frames, about 7 s on 4 CPUs with no GPU.
import fs from 'node:fs';
import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {selectComposition, renderMedia, renderStill} from '@remotion/renderer';

const root = path.dirname(new URL(import.meta.url).pathname);
const id = process.argv[2] ?? 'Promo';
const stillFrame = Number(process.argv[3] ?? 75);

// Use the Chromium that ships with the container instead of letting Remotion download one.
const candidates = [
  '/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
  ...(fs.existsSync('/opt/pw-browsers')
    ? fs.readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium_headless_shell'))
        .map((d) => `/opt/pw-browsers/${d}/chrome-headless-shell-linux64/chrome-headless-shell`)
    : []),
];
const browserExecutable = candidates.find((p) => fs.existsSync(p)) ?? null; // null: Remotion downloads its own
const chromiumOptions = {gl: 'swangle'}; // software WebGL, so shaders and Three.js render without a GPU

fs.mkdirSync(path.join(root, 'out'), {recursive: true});
const serveUrl = await bundle({entryPoint: path.join(root, 'src/index.jsx')});
const composition = await selectComposition({serveUrl, id, browserExecutable, chromiumOptions});
const t0 = Date.now();
await renderStill({serveUrl, composition, frame: stillFrame, output: path.join(root, `out/${id}-still.png`), browserExecutable, chromiumOptions});
await renderMedia({serveUrl, composition, codec: 'h264', outputLocation: path.join(root, `out/${id}.mp4`), browserExecutable, chromiumOptions});
console.log(`rendered ${id} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
