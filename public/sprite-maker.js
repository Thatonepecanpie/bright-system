// Custom sprites: turn any picture into an agent's sprite. Fit it into the round body (drag to move,
// slider to zoom), pick a style (as is, toon or pixel) and save a small image, about 20 KB, that the
// Floor animates like any other sprite. On claude.ai, "Make one with Higgsfield" draws a cartoon sprite
// from a description with the viewer's Higgsfield connector (BOARD_HIGGSFIELD, in claude-transport.js);
// elsewhere the dialog offers a prompt for ChatGPT's image generation instead.
// Uses app.js globals at call time: openDialog, copyText, esc, $, token.
'use strict';

const SpriteMaker = (() => {
  const OUT = 192;
  const MAX_CHARS = 140000;
  const MORPH_PROMPT = 'Redraw the character in the attached picture as a cute, round mascot head for a game sprite: chibi proportions, big expressive eyes, flat vector colours, a thick clean dark outline, centred and filling a circle, plain light background, no text.';
  let img = null, zoom = 1, ox = 0, oy = 0, style = 'toon';

  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  function posterize(p, levels, boost) {
    const step = 255 / (levels - 1);
    for (let i = 0; i < p.length; i += 4) {
      const m = (p[i] + p[i + 1] + p[i + 2]) / 3;
      for (let c = 0; c < 3; c++) p[i + c] = clamp(Math.round(clamp(m + (p[i + c] - m) * boost) / step) * step);
    }
  }

  // Flat colours plus dark outlines where the brightness changes sharply: a quick cel-shaded look.
  function toon(ctx, n) {
    const d = ctx.getImageData(0, 0, n, n);
    const p = d.data;
    const lum = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) lum[i] = 0.299 * p[i * 4] + 0.587 * p[i * 4 + 1] + 0.114 * p[i * 4 + 2];
    posterize(p, 5, 1.35);
    for (let y = 1; y < n - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        const i = y * n + x;
        const gx = lum[i - n + 1] + 2 * lum[i + 1] + lum[i + n + 1] - lum[i - n - 1] - 2 * lum[i - 1] - lum[i + n - 1];
        const gy = lum[i + n - 1] + 2 * lum[i + n] + lum[i + n + 1] - lum[i - n - 1] - 2 * lum[i - n] - lum[i - n + 1];
        if (Math.hypot(gx, gy) > 150) { p[i * 4] *= 0.22; p[i * 4 + 1] *= 0.22; p[i * 4 + 2] *= 0.22; }
      }
    }
    ctx.putImageData(d, 0, 0);
  }

  function draw(canvas) {
    const n = canvas.width;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, n, n);
    if (!img) return;
    const k = Math.max(n / img.width, n / img.height) * zoom;
    const w = img.width * k, h = img.height * k;
    const x = (n - w) / 2 + ox * n, y = (n - h) / 2 + oy * n;
    if (style === 'pixel') {
      const s = 28;
      const t = document.createElement('canvas');
      t.width = t.height = s;
      const tc = t.getContext('2d');
      tc.fillStyle = '#ffffff';
      tc.fillRect(0, 0, s, s);
      tc.drawImage(img, (x * s) / n, (y * s) / n, (w * s) / n, (h * s) / n);
      const d = tc.getImageData(0, 0, s, s);
      posterize(d.data, 6, 1.2);
      tc.putImageData(d, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(t, 0, 0, n, n);
      ctx.imageSmoothingEnabled = true;
    } else {
      ctx.drawImage(img, x, y, w, h);
      if (style === 'toon') toon(ctx, n);
    }
  }

  function encode(canvas) {
    for (const q of [0.85, 0.7, 0.55, 0.4]) {
      let url = canvas.toDataURL('image/webp', q);
      if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', q);
      if (url.length <= MAX_CHARS) return url;
    }
    return '';
  }

  function load(src) {
    return new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That file is not an image this browser can open.'));
      i.src = src;
    });
  }

  function open(agent, color, current, onSave) {
    img = null; zoom = 1; ox = 0; oy = 0; style = 'toon';
    openDialog(`${agent.display_name}: sprite`, `
      <p class="small">Give ${esc(agent.display_name)} any picture. It becomes the face of its round sprite and keeps every animation: walking, typing, celebrating.</p>
      <div class="sm-wrap">
        <div class="sm-stage" style="--c:${color}"><canvas id="sm-canvas" width="${OUT}" height="${OUT}" aria-label="Preview: drag to move the picture"></canvas><span class="sm-empty">Choose a picture</span></div>
        <div class="sm-controls">
          <label class="btn" for="sm-file">Choose picture…</label><input type="file" id="sm-file" accept="image/*" class="sm-file-input" tabindex="-1">
          <label for="sm-zoom">Zoom</label><input type="range" id="sm-zoom" min="1" max="4" step="0.05" value="1">
          <div class="sm-styles" role="radiogroup" aria-label="Style">
            ${[['plain', 'As is'], ['toon', 'Toon'], ['pixel', 'Pixel']].map(([v, l]) => `<label class="inline"><input type="radio" name="sm-style" value="${v}"${v === style ? ' checked' : ''}> ${l}</label>`).join('')}
          </div>
          <p class="small muted">Drag the preview to move the picture.</p>
        </div>
      </div>
      ${window.BOARD_HIGGSFIELD ? `<div class="sm-hf">
        <h3>✨ Make one with Higgsfield</h3>
        <p class="small">Describe a look: a character, an animal, a style. Higgsfield draws it as a cartoon sprite with your plan's credits (<span id="sm-hf-cost">about 0.25</span> per picture); nothing else is charged.</p>
        <div class="sm-hf-row"><input id="sm-hf-look" maxlength="200" placeholder="e.g. Sasuke Uchiha, a fox astronaut, a samurai cat"><button class="btn primary" type="button" id="sm-hf-go">Draw it</button></div>
        <p class="small muted" id="sm-hf-status" aria-live="polite"></p>
      </div>` : ''}
      <details class="sm-morph"><summary>${window.BOARD_HIGGSFIELD ? 'Or redraw your own picture in ChatGPT' : 'Want a real cartoon version of a character?'}</summary>
        <p class="small">ChatGPT can redraw it (image generation is included in your Plus plan, so it costs nothing extra). Paste this with the picture, then choose what it draws here:</p>
        <textarea id="sm-prompt" rows="3" readonly>${esc(MORPH_PROMPT)}</textarea>
        <div class="actions"><button class="btn small" type="button" id="sm-copy">Copy prompt</button></div>
      </details>
      <div class="dialog-error error hidden" id="sm-error"></div>
      <div class="actions">
        <button class="btn primary" type="button" id="sm-save" disabled>Save sprite</button>
        ${current ? '<button class="btn" type="button" id="sm-remove">Back to the classic sprite</button>' : ''}
      </div>`);
    const canvas = $('#sm-canvas');
    const stage = canvas.parentElement;
    const redraw = () => { draw(canvas); stage.classList.toggle('ready', !!img); $('#sm-save').disabled = !img; };
    const fail = (msg) => { const e = $('#sm-error'); e.textContent = msg; e.classList.remove('hidden'); };
    const use = async (src) => {
      try { img = await load(src); zoom = 1; ox = 0; oy = 0; $('#sm-zoom').value = 1; redraw(); } catch (e) { fail(e.message); }
    };
    if (current) use(current).then(() => { style = 'plain'; document.querySelector('input[name="sm-style"][value="plain"]').checked = true; redraw(); });
    else redraw();

    $('#sm-file').addEventListener('change', (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      if (f.size > 15 * 1024 * 1024) return fail('That picture is over 15 MB. Try a smaller one.');
      const r = new FileReader();
      r.onload = () => { style = document.querySelector('input[name="sm-style"]:checked').value; use(r.result); };
      r.readAsDataURL(f);
    });
    $('#sm-zoom').addEventListener('input', (ev) => { zoom = Number(ev.target.value); redraw(); });
    for (const r of document.querySelectorAll('input[name="sm-style"]')) r.addEventListener('change', () => { style = r.value; redraw(); });
    let dragAt = null;
    canvas.addEventListener('pointerdown', (e) => { if (!img) return; dragAt = [e.clientX, e.clientY, ox, oy]; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragAt) return;
      const size = canvas.getBoundingClientRect().width || OUT;
      ox = dragAt[2] + (e.clientX - dragAt[0]) / size;
      oy = dragAt[3] + (e.clientY - dragAt[1]) / size;
      redraw();
    });
    const stop = () => { dragAt = null; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    $('#sm-copy').addEventListener('click', () => copyText(MORPH_PROMPT, $('#sm-copy')));
    if (window.BOARD_HIGGSFIELD) {
      const status = (t) => { $('#sm-hf-status').textContent = t; };
      window.BOARD_HIGGSFIELD.cost('a character').then((c) => { if (c != null && $('#sm-hf-cost')) $('#sm-hf-cost').textContent = `${c} credits`; }).catch(() => {});
      const go = async () => {
        const look = $('#sm-hf-look').value.trim();
        if (!look) return status('Describe the look first.');
        $('#sm-hf-go').disabled = true;
        try {
          const pic = await window.BOARD_HIGGSFIELD.make(look, token(), status);
          style = 'plain';
          document.querySelector('input[name="sm-style"][value="plain"]').checked = true;
          await use(pic);
          status('Done. Adjust it if you like, then Save sprite. Not quite right? Draw it again.');
        } catch (e) { status(e.message); }
        $('#sm-hf-go').disabled = false;
      };
      $('#sm-hf-go').addEventListener('click', go);
      $('#sm-hf-look').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    }
    $('#sm-save').addEventListener('click', async () => {
      const url = encode(canvas);
      if (!url) return fail('The picture is too detailed to store. Try zooming in or the Pixel style.');
      $('#sm-save').disabled = true;
      try { await onSave(url); $('#dialog').close(); } catch (e) { fail(e.message); $('#sm-save').disabled = false; }
    });
    const rm = $('#sm-remove');
    if (rm) rm.addEventListener('click', async () => { try { await onSave(''); $('#dialog').close(); } catch (e) { fail(e.message); } });
  }

  return { open, MORPH_PROMPT };
})();
