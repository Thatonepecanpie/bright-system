// The Floor drawn as a small isometric office. Every agent is a round sprite that goes where its
// status says: typing at its desk while it holds a task, wandering between the water cooler,
// coffee corner, windows and plants between turns, at the bulletin board when it is overdue, on a
// coffee break when paused, and by the door until it first connects. A fresh message makes its
// author walk over to the recipient. Click an agent for details, right-click (or long-press) for
// actions, drag it anywhere; drop it on the bulletin board to give it a task. The bulletin board,
// mailbox, file cabinet, safe and trophy shelf are shortcuts to their tabs.
// Uses app.js globals at call time: state, agentState, colorFor, esc, ago, until, meter, fmtNum,
// newTask, messageDialog.
'use strict';

const Office = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 14, D = 11, WALL = 2.6, S = 30, C = 0.866 * S, H = 0.5 * S;
  const SPEED = 2.4; // floor units per second
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Floor coordinates (x to the right-front, y to the left-front, z up) to SVG coordinates.
  const P = (x, y, z = 0) => [(x - y) * C, (x + y) * H - z * S];
  const pt = (x, y, z) => P(x, y, z).map((n) => n.toFixed(1)).join(',');
  const poly = (cls, corners) => `<polygon class="${cls}" points="${corners.map((c) => pt(...c)).join(' ')}"/>`;
  const line = (cls, a, b) => { const [x1, y1] = P(...a), [x2, y2] = P(...b); return `<line class="${cls}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`; };

  // A shaded box: the two faces that face the viewer, then the top.
  function box(x, y, w, d, h, z = 0, cls = '') {
    const z1 = z + h;
    return `<g class="box ${cls}">`
      + poly('l', [[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z1], [x, y + d, z1]])
      + poly('r', [[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z1], [x + w, y, z1]])
      + poly('t', [[x, y, z1], [x + w, y, z1], [x + w, y + d, z1], [x, y + d, z1]])
      + '</g>';
  }
  const leftWall = (cls, y0, y1, z0, z1) => poly(cls, [[0.02, y0, z0], [0.02, y1, z0], [0.02, y1, z1], [0.02, y0, z1]]);
  const rightWall = (cls, x0, x1, z0, z1) => poly(cls, [[x0, 0.02, z0], [x1, 0.02, z0], [x1, 0.02, z1], [x0, 0.02, z1]]);
  const front = (cls, y, x0, x1, z0, z1) => poly(cls, [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]]);
  const ring = (cls, cx, y, cz, r) => poly(cls, Array.from({ length: 20 }, (_, i) => {
    const t = (i / 20) * Math.PI * 2;
    return [cx + r * Math.cos(t), y, cz + r * Math.sin(t)];
  }));

  // ---------- layout ----------

  const SLOTS = [[5.6, 2.6], [8.2, 2.6], [5.6, 5.6], [8.2, 5.6], [3.0, 2.6], [10.8, 2.6], [3.0, 5.6], [10.8, 5.6]];
  // Walkways: agents travel along these rows and columns so they never cut through furniture.
  const ROWS = [1.65, 4.8, 7.7];
  const COLS = [1.6, 5.2, 7.8, 10.4, 13.3];
  const SPOTS = {
    bulletin: { x: 0.95, y: 3.75 }, water: { x: 1.55, y: 6.35 },
    coffeeN: { x: 9.4, y: 8.15 }, coffeeW: { x: 8.05, y: 9.25 }, coffeeE: { x: 10.75, y: 9.25 },
    window1: { x: 4.0, y: 0.9 }, window2: { x: 7.6, y: 0.9 }, plant: { x: 12.7, y: 10.0 }, door: { x: 0.95, y: 9.6 },
  };
  const IDLE = ['seat', 'seat', 'water', 'coffeeN', 'coffeeW', 'coffeeE', 'window1', 'window2', 'bulletin', 'plant'];
  const ICON = { seat: 'zz', water: 'drop', coffeeN: 'cup', coffeeW: 'cup', coffeeE: 'cup', window1: 'sun', window2: 'sun', bulletin: 'board', plant: 'leaf' };
  const DOING = {
    seat: 'resting at its desk', water: 'at the water cooler', coffeeN: 'on a coffee break', coffeeW: 'on a coffee break',
    coffeeE: 'on a coffee break', window1: 'looking out the window', window2: 'looking out the window',
    bulletin: 'reading the bulletin board', plant: 'watering the plants', msg: 'dropping off a message',
    held: 'where you put it', door: 'waiting by the door',
  };
  const BUBBLE = {
    typing: '<circle class="bb" r="9"/><circle class="td" cx="-4" r="1.5"/><circle class="td" r="1.5"/><circle class="td" cx="4" r="1.5"/>',
    cup: '<circle class="bb" r="9"/><path class="ic" d="M-4.5 -3h7v3.5a3.5 3.5 0 0 1-7 0z M2.5 -1.5h1.2a1.6 1.6 0 0 1 0 3.2H2.3"/>',
    drop: '<circle class="bb" r="9"/><path class="ic-water" d="M0 -5.2c2.6 3.1 4 4.9 4 6.7a4 4 0 0 1-8 0c0-1.8 1.4-3.6 4-6.7z"/>',
    board: '<circle class="bb" r="9"/><rect class="ic" x="-4" y="-4.5" width="8" height="9" rx="1.2"/><path class="ic" d="M-2 -1.5h4M-2 1h4M-2 3.4h2.4"/>',
    alert: '<circle class="bb-warn" r="9"/><path class="ic-w" d="M0 -4.6v4.8"/><circle class="ic-wf" cy="3.5" r="1.2"/>',
    pause: '<circle class="bb" r="9"/><path class="ic" d="M-2 -3.6v7.2M2 -3.6v7.2"/>',
    zz: '<circle class="bb" r="9"/><text class="ic-t" x="-1" y="3">z</text><text class="ic-t small" x="3.5" y="-1.5">z</text>',
    chat: '<circle class="bb-acc" r="9"/><circle class="ic-wf" cx="-3.6" r="1.3"/><circle class="ic-wf" r="1.3"/><circle class="ic-wf" cx="3.6" r="1.3"/>',
    q: '<circle class="bb" r="9"/><text class="ic-t" y="3.4">?</text>',
    sun: '<circle class="bb" r="9"/><circle class="ic-sun" r="3"/><path class="ic-sunray" d="M0 -6v1.6M0 4.4V6M-6 0h1.6M4.4 0H6M-4.2 -4.2l1.1 1.1M3.1 3.1l1.1 1.1M-4.2 4.2l1.1-1.1M3.1 -3.1l1.1-1.1"/>',
    leaf: '<circle class="bb" r="9"/><path class="ic-leaf" d="M-4 4c0-5.5 3.5-8.5 8-8.5 0 5-3 8.5-8 8.5z"/><path class="ic" d="M-4 4 1.5 -1.5"/>',
  };

  const nearestRow = (y) => ROWS.reduce((a, b) => (Math.abs(b - y) < Math.abs(a - y) ? b : a));
  function route(from, to) {
    const ra = nearestRow(from.y), rb = nearestRow(to.y);
    const out = [{ x: from.x, y: ra }];
    if (ra !== rb) {
      const col = COLS.reduce((a, b) => (Math.abs(from.x - b) + Math.abs(to.x - b) < Math.abs(from.x - a) + Math.abs(to.x - a) ? b : a));
      out.push({ x: col, y: ra }, { x: col, y: rb });
    }
    out.push({ x: to.x, y: rb }, { x: to.x, y: to.y });
    return out.filter((p, i) => {
      const q = i ? out[i - 1] : from;
      return Math.hypot(p.x - q.x, p.y - q.y) > 0.01;
    });
  }

  // ---------- scene ----------

  function walls() {
    let s = poly('of-floor', [[0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0]]);
    let grid = '';
    for (let i = 1; i < W; i++) grid += line('', [i, 0, 0], [i, D, 0]);
    for (let j = 1; j < D; j++) grid += line('', [0, j, 0], [W, j, 0]);
    s += `<g class="of-grid">${grid}</g>`;
    s += poly('of-rug', [[7.7, 7.95, 0], [11.5, 7.95, 0], [11.5, 10.6, 0], [7.7, 10.6, 0]]);
    s += poly('of-wall-l', [[0, 0, 0], [0, D, 0], [0, D, WALL], [0, 0, WALL]]);
    s += poly('of-wall-r', [[0, 0, 0], [W, 0, 0], [W, 0, WALL], [0, 0, WALL]]);
    s += poly('of-wall-cap', [[0, 0, WALL], [0, D, WALL], [-0.16, D, WALL], [-0.16, -0.16, WALL]]);
    s += poly('of-wall-cap', [[0, 0, WALL], [W, 0, WALL], [W, -0.16, WALL], [-0.16, -0.16, WALL]]);
    for (const [x0, x1] of [[3, 5], [6.6, 8.6]]) {
      s += rightWall('of-window', x0, x1, 1.0, 2.1) + line('of-mullion', [(x0 + x1) / 2, 0.03, 1.0], [(x0 + x1) / 2, 0.03, 2.1])
        + line('of-mullion', [x0, 0.03, 1.55], [x1, 0.03, 1.55]);
    }
    s += `<g class="of-clock">${ring('of-clock-face', 10.3, 0.03, 1.85, 0.32)}<line class="of-hand h"/><line class="of-hand m"/></g>`;
    s += `<g class="of-door">${leftWall('of-door-panel', 8.55, 9.95, 0, 2.05)}${line('of-door-line', [0.03, 9.25, 0.05], [0.03, 9.25, 2.0])}<circle class="of-knob" cx="${P(0.04, 9.75, 1.0)[0].toFixed(1)}" cy="${P(0.04, 9.75, 1.0)[1].toFixed(1)}" r="1.8"/></g>`;
    s += `<g class="of-hot" data-goto="board" tabindex="0" role="link" aria-label="Bulletin board: open the Board"><title>Bulletin board · open the Board</title>${leftWall('of-cork', 2.35, 5.05, 0.95, 2.1)}<g class="of-cards"></g></g>`;
    s += `<g class="of-hot" data-goto="messages" tabindex="0" role="link" aria-label="Mailbox: open Messages"><title>Mailbox · open Messages</title>${leftWall('of-mail', 7.05, 7.85, 1.25, 1.85)}${line('of-mail-slot', [0.03, 7.2, 1.66], [0.03, 7.7, 1.66])}<circle class="of-mail-dot" r="3.2" cx="${P(0.03, 7.85, 1.85)[0].toFixed(1)}" cy="${P(0.03, 7.85, 1.85)[1].toFixed(1)}"/></g>`;
    return s;
  }

  function deskHtml(x, y, i) {
    const sy = y + 0.195;
    return box(x + 0.06, y + 0.08, 0.08, 0.84, 0.68, 0, 'm-desk') + box(x + 1.66, y + 0.08, 0.08, 0.84, 0.68, 0, 'm-desk')
      + box(x, y, 1.8, 1.0, 0.07, 0.68, 'm-desk')
      + box(x + 0.85, y + 0.14, 0.1, 0.06, 0.12, 0.75, 'm-dark')
      + box(x + 0.45, y + 0.12, 0.9, 0.07, 0.5, 0.86, 'm-dark')
      + `<g class="of-screen" data-screen="${i}">${front('scr', sy, x + 0.5, x + 1.3, 0.9, 1.32)}`
      + line('code c1', [x + 0.58, sy, 1.22], [x + 1.02, sy, 1.22]) + line('code c2', [x + 0.66, sy, 1.12], [x + 1.18, sy, 1.12])
      + line('code c3', [x + 0.58, sy, 1.02], [x + 0.92, sy, 1.02]) + '</g>'
      + box(x + 0.55, y + 0.55, 0.7, 0.22, 0.02, 0.75, 'm-key');
  }
  const chairHtml = (cx, cy) => box(cx - 0.04, cy - 0.04, 0.08, 0.08, 0.4, 0, 'm-dark') + box(cx - 0.27, cy - 0.27, 0.54, 0.54, 0.06, 0.4, 'm-chair');
  function plantHtml(x, y, tall) {
    const [px, py] = P(x + 0.25, y + 0.25, tall ? 1.25 : 0.85);
    return box(x, y, 0.5, 0.5, 0.45, 0, 'm-pot')
      + `<ellipse class="of-leaf b" cx="${px.toFixed(1)}" cy="${(py + 6).toFixed(1)}" rx="${tall ? 13 : 11}" ry="${tall ? 15 : 10}"/>`
      + `<ellipse class="of-leaf" cx="${(px - 3).toFixed(1)}" cy="${(py - 2).toFixed(1)}" rx="${tall ? 9 : 8}" ry="${tall ? 12 : 8}"/>`;
  }

  function furniture(n) {
    const items = [];
    const add = (depth, html, attrs = '') => items.push(`<g data-depth="${depth.toFixed(2)}"${attrs}>${html}</g>`);
    SLOTS.slice(0, n).forEach(([x, y], i) => {
      add(x + y + 1.4, deskHtml(x, y, i));
      add(x + y + 2.27, chairHtml(x + 0.9, y + 1.42));
    });
    add(0.7 + 6.33, box(0.35, 6.0, 0.65, 0.65, 0.95, 0, 'm-white') + box(0.47, 6.12, 0.41, 0.41, 0.5, 0.95, 'm-water')
      + box(0.62, 6.65, 0.1, 0.06, 0.08, 0.62, 'm-dark'));
    add(9.4 + 9.2, box(8.6, 8.6, 1.6, 1.2, 0.42, 0, 'm-wood') + box(9.0, 8.85, 0.16, 0.16, 0.12, 0.42, 'm-white') + box(9.65, 9.25, 0.16, 0.16, 0.12, 0.42, 'm-white'));
    add(0.55 + 0.55, plantHtml(0.3, 0.3, true));
    add(13.5 + 10.5, plantHtml(13.25, 10.25, false));
    add(0.55 + 10.55, plantHtml(0.3, 10.3, false));
    add(1.7 + 0.35, `<title>Trophy shelf · open Wins</title>${box(1.0, 0.12, 1.4, 0.45, 1.3, 0, 'm-wood')}${box(1.25, 0.22, 0.22, 0.22, 0.25, 1.3, 'm-gold')}${box(1.85, 0.22, 0.2, 0.2, 0.18, 1.3, 'm-gold')}`,
      ' class="of-hot" data-goto="wins" tabindex="0" role="link" aria-label="Trophy shelf: open Wins"');
    add(11.65 + 0.5, `<title>File cabinet · open Files</title>${box(11.2, 0.12, 0.9, 0.75, 1.35, 0, 'm-cab')}`
      + [0.45, 0.9].map((z) => line('of-drawer', [11.22, 0.871, z], [12.08, 0.871, z])).join('')
      + [0.25, 0.7, 1.15].map((z) => line('of-handle', [11.55, 0.872, z], [11.75, 0.872, z])).join(''),
    ' class="of-hot" data-goto="files" tabindex="0" role="link" aria-label="File cabinet: open Files"');
    add(12.87 + 0.55, `<title>Safe · open the Vault</title>${box(12.4, 0.12, 0.95, 0.85, 0.95, 0, 'm-safe')}${ring('of-dial', 12.87, 0.972, 0.5, 0.17)}${line('of-handle light', [12.87, 0.973, 0.5], [13.0, 0.973, 0.58])}`,
      ' class="of-hot" data-goto="vault" tabindex="0" role="link" aria-label="Safe: open the Vault"');
    return items.join('');
  }

  // ---------- state ----------

  let root, svg, world, overlay, pop, menu;
  let spriteScale = 1, deskCount = 0, raf = 0, last = 0, lastClock = 0, firstUpdate = true, selected = '', menuFor = '';
  const agents = new Map();
  const seenMsgs = new Set();
  let drag = null;

  const seat = (o) => { const [x, y] = SLOTS[o.desk % SLOTS.length]; return { x: x + 0.9, y: y + 1.42 }; };
  const spotPos = (o, key) => (key === 'seat' ? seat(o) : SPOTS[key]);
  const taken = (key, me) => [...agents.values()].some((o) => o !== me && o.spot === key);

  function setIcon(o, icon) {
    if (o.icon === icon) return;
    o.icon = icon;
    o.bubble.innerHTML = icon ? `<g class="bin">${BUBBLE[icon]}</g>` : '';
  }

  function goto(o, key, pos, icon, dwellMs) {
    const now = performance.now();
    if (o.spot === key && !o.path.length && Math.hypot(o.x - pos.x, o.y - pos.y) < 0.05) {
      o.dwellUntil = now + dwellMs;
      setIcon(o, icon);
      return;
    }
    o.spot = key; o.pendingIcon = icon; o.dwellMs = dwellMs;
    setIcon(o, null);
    o.path = route(o, pos);
    if (!o.path.length) arrive(o, now);
  }
  function arrive(o, now) {
    o.dwellUntil = now + o.dwellMs;
    setIcon(o, o.pendingIcon);
  }

  function decide(o, now) {
    if (o.dragging || now < o.heldUntil) return;
    if (o.event) {
      if (o.event.done) o.event = null;
      else {
        const to = agents.get(o.event.to);
        const pos = to && to !== o ? { x: Math.max(0.6, to.x - 0.75), y: to.y } : SPOTS.bulletin;
        o.event.done = true;
        return goto(o, 'msg', pos, 'chat', 4500);
      }
    }
    if (o.st === 'working') return goto(o, 'seat', seat(o), 'typing', 4000);
    if (o.st === 'late') return goto(o, 'bulletin', SPOTS.bulletin, 'alert', 6000);
    if (o.st === 'paused') { const k = ['coffeeW', 'coffeeE', 'coffeeN'][o.desk % 3]; return goto(o, k, SPOTS[k], 'pause', 8000); }
    if (o.st === 'offline') return goto(o, 'door', SPOTS.door, 'q', 8000);
    const options = IDLE.filter((k) => k !== o.spot && (k === 'seat' || !taken(k, o)));
    const key = options[Math.floor(Math.random() * options.length)] || 'seat';
    goto(o, key, spotPos(o, key), ICON[key], 6000 + Math.random() * 8000);
  }

  function draw(o, now) {
    const [sx, sy] = P(o.x, o.y);
    const at = `translate(${sx.toFixed(1)} ${sy.toFixed(1)})${spriteScale !== 1 ? ` scale(${spriteScale})` : ''}`;
    o.el.setAttribute('transform', at);
    o.tag.setAttribute('transform', at);
    const moving = o.path.length > 0 || o.dragging;
    o.el.classList.toggle('moving', moving);
    if (moving && !reduced()) o.bob.setAttribute('transform', `translate(0 ${(-Math.abs(Math.sin(now / 95)) * 3).toFixed(1)})`);
    else o.bob.removeAttribute('transform');
    // Eyes look where the agent is going, or at the screen while it types.
    let [dx, dy] = o.dir;
    if (!moving && o.spot === 'seat') [dx, dy] = [0, -1];
    let vx = (dx - dy) * C, vy = (dx + dy) * H;
    const len = Math.hypot(vx, vy) || 1;
    vx = (vx / len) * 1.4; vy = (vy / len) * 1.1;
    o.pupils.setAttribute('transform', `translate(${vx.toFixed(1)} ${vy.toFixed(1)})`);
  }

  function step(o, now, dt) {
    if (!o.dragging) {
      if (o.path.length) {
        const t = o.path[0];
        const dx = t.x - o.x, dy = t.y - o.y, dist = Math.hypot(dx, dy);
        const len = reduced() ? Infinity : SPEED * dt;
        if (dist > 0.001) o.dir = [dx / dist, dy / dist];
        if (dist <= len) { o.x = t.x; o.y = t.y; o.path.shift(); if (!o.path.length) arrive(o, now); }
        else { o.x += (dx / dist) * len; o.y += (dy / dist) * len; }
      } else if (now >= o.dwellUntil) decide(o, now);
    }
    draw(o, now);
  }

  function sortDepth() {
    const kids = [...world.children];
    const depth = (el) => (el.__agent ? el.__agent.x + el.__agent.y + (el.__agent.dragging ? 100 : 0.02) : Number(el.dataset.depth));
    const sorted = kids.slice().sort((a, b) => depth(a) - depth(b));
    if (sorted.some((el, i) => el !== kids[i])) {
      const focused = document.activeElement;
      sorted.forEach((el) => world.appendChild(el));
      if (focused && focused !== document.activeElement && world.contains(focused)) focused.focus({ preventScroll: true });
    }
  }

  function tickClock() {
    const d = new Date();
    const hand = (cls, frac, len) => {
      const a = frac * Math.PI * 2;
      const [x1, y1] = P(10.3, 0.03, 1.85), [x2, y2] = P(10.3 + Math.sin(a) * len, 0.03, 1.85 + Math.cos(a) * len);
      const el = svg.querySelector(`.of-hand.${cls}`);
      if (el) { el.setAttribute('x1', x1.toFixed(1)); el.setAttribute('y1', y1.toFixed(1)); el.setAttribute('x2', x2.toFixed(1)); el.setAttribute('y2', y2.toFixed(1)); }
    };
    hand('h', ((d.getHours() % 12) + d.getMinutes() / 60) / 12, 0.18);
    hand('m', d.getMinutes() / 60, 0.27);
  }

  function frame() {
    raf = 0;
    if (!root || !root.isConnected || document.hidden) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // Small screens shrink the whole room, so draw the agents bigger to keep them readable.
    spriteScale = root.clientWidth < 560 ? 1.5 : 1;
    for (const o of agents.values()) step(o, now, dt);
    sortDepth();
    if (selected) placeFloating(pop, agents.get(selected), 22);
    if (now - lastClock > 15000) { lastClock = now; tickClock(); }
    raf = requestAnimationFrame(frame);
  }
  function start() {
    if (raf || !root || !root.isConnected) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  // ---------- building ----------

  function init() {
    root = document.createElement('div');
    root.className = 'office';
    const minX = -D * C - 12, maxX = W * C + 12, minY = -WALL * S - 14, maxY = (W + D) * H + 18;
    root.innerHTML = `<svg viewBox="${minX.toFixed(0)} ${minY.toFixed(0)} ${(maxX - minX).toFixed(0)} ${(maxY - minY).toFixed(0)}" role="group" aria-label="Office floor"></svg>
      <div class="of-pop hidden" role="dialog" aria-label="Agent status"></div>
      <div class="of-menu hidden" role="menu"></div>`;
    svg = root.querySelector('svg');
    pop = root.querySelector('.of-pop');
    menu = root.querySelector('.of-menu');
    bindEvents();
    document.addEventListener('visibilitychange', start);
  }

  function build(n) {
    deskCount = n;
    svg.innerHTML = `${walls()}<g class="of-world">${furniture(n)}</g><g class="of-overlay"></g>`;
    world = svg.querySelector('.of-world');
    overlay = svg.querySelector('.of-overlay');
    for (const o of agents.values()) { world.appendChild(o.el); overlay.appendChild(o.tag); }
    lastClock = 0;
  }

  function createAgent(a, desk) {
    const el = document.createElementNS(NS, 'g');
    el.setAttribute('class', 'of-agent');
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.dataset.agent = a.id;
    el.style.setProperty('--c', colorFor(a.id));
    el.innerHTML = `<title></title><ellipse class="ag-shadow" rx="11" ry="5"/><ellipse class="ag-ring" rx="16" ry="8"/>
      <g class="ag-bob"><circle class="ag-body" cy="-18" r="11"/><circle class="ag-shine" cx="-4" cy="-23" r="3"/>
      <g class="ag-eyes"><circle cx="-4" cy="-19" r="3"/><circle cx="4" cy="-19" r="3"/>
      <g class="ag-pupils"><circle cx="-4" cy="-19" r="1.5"/><circle cx="4" cy="-19" r="1.5"/></g></g></g>`;
    // Name and speech bubble live in a layer above the furniture so desks never hide them.
    const tag = document.createElementNS(NS, 'g');
    tag.setAttribute('class', 'of-tag');
    tag.innerHTML = '<g class="ag-bubble" transform="translate(13 -36)"></g><text class="ag-name" y="15"></text>';
    const o = {
      id: a.id, data: a, el, tag, desk, st: '', spot: '', icon: null, pendingIcon: null, path: [], dir: [0, 1],
      dwellUntil: 0, dwellMs: 0, heldUntil: 0, dragging: false, event: null,
      bob: el.querySelector('.ag-bob'), pupils: el.querySelector('.ag-pupils'), bubble: tag.querySelector('.ag-bubble'),
    };
    el.__agent = o;
    o.st = agentState(a)[0];
    const home = o.st === 'working' ? seat(o) : o.st === 'offline' ? SPOTS.door : seat(o);
    o.x = home.x; o.y = home.y;
    world.appendChild(el);
    overlay.appendChild(tag);
    agents.set(a.id, o);
    decide(o, performance.now());
    // Start settled where it belongs instead of walking in from the desk.
    if (o.path.length) { const end = o.path[o.path.length - 1]; o.x = end.x; o.y = end.y; o.path = []; arrive(o, performance.now()); }
    return o;
  }

  function update(snap) {
    if (!root || !snap) return;
    const list = snap.agents.filter((a) => !a.retired_at);
    const n = Math.max(4, Math.min(SLOTS.length, list.length));
    if (n !== deskCount) build(n);
    const now = performance.now();
    const live = new Set();
    list.forEach((a, i) => {
      live.add(a.id);
      const o = agents.get(a.id) || createAgent(a, i);
      o.data = a;
      o.desk = i;
      const [st, label] = agentState(a);
      if (st !== o.st) {
        o.st = st;
        if (!o.dragging && now >= o.heldUntil && !o.path.length) o.dwellUntil = 0;
      }
      o.el.setAttribute('class', `of-agent st-${st}${o.dragging ? ' dragging' : ''}${selected === a.id ? ' selected' : ''}`);
      o.el.setAttribute('aria-label', `${a.display_name}: ${label}. Press Enter for details.`);
      o.el.querySelector('title').textContent = `${a.display_name}: ${label}`;
      o.tag.setAttribute('class', `of-tag st-${st}`);
      o.tag.querySelector('.ag-name').textContent = a.display_name;
    });
    for (const [id, o] of agents) if (!live.has(id)) { o.el.remove(); o.tag.remove(); agents.delete(id); if (selected === id) closePop(); }

    // Monitors light up for the agents holding a task.
    svg.querySelectorAll('.of-screen').forEach((s) => {
      const o = [...agents.values()].find((x) => x.desk === Number(s.dataset.screen));
      const on = !!(o && o.st === 'working');
      s.classList.toggle('on', on);
      if (o) s.style.setProperty('--c', colorFor(o.id));
    });

    // The bulletin board mirrors the open tasks.
    const open = snap.tasks.filter((t) => ['needs_fernando', 'ready', 'in_progress', 'review', 'blocked'].includes(t.status)).slice(0, 8);
    svg.querySelector('.of-cards').innerHTML = open.map((t, i) => {
      const col = i % 4, row = Math.floor(i / 4);
      const y0 = 2.55 + col * 0.62, z1 = 1.95 - row * 0.5;
      return `<g class="of-card s-${t.status}">${leftWall('', y0, y0 + 0.45, z1 - 0.38, z1)}</g>`;
    }).join('');

    const toMe = snap.messages.filter((m) => m.to_agent === 'fernando' && Date.now() - new Date(m.created_at).getTime() < 2 * 86400e3).length;
    svg.querySelector('.of-mail-dot').classList.toggle('on', toMe > 0);

    // Fresh messages: the author walks over to the recipient (or to the board, for everyone).
    for (const m of snap.messages) {
      if (seenMsgs.has(m.id)) continue;
      seenMsgs.add(m.id);
      const age = Date.now() - new Date(m.created_at).getTime();
      if (age > (firstUpdate ? 3 : 10) * 60e3) continue;
      const o = agents.get(m.author);
      if (!o) continue;
      o.event = { to: m.to_agent, done: false };
      if (!o.dragging && now >= o.heldUntil && !o.path.length) o.dwellUntil = 0;
    }
    firstUpdate = false;

    if (selected) renderPop();
    tickClock();
  }

  // ---------- details card and menu ----------

  function doing(o) {
    const a = o.data;
    const [, label] = agentState(a);
    if (a.active_task) return `Working on <a href="#" data-task="${a.active_task.id}">${esc(a.active_task.ref)} · ${esc(a.active_task.title)}</a> <span class="muted">· ${until(a.active_task.lease_expires_at)}</span>`;
    const where = DOING[o.dragging || performance.now() < o.heldUntil ? 'held' : o.spot];
    return `${esc(label)}${where ? ' · ' + where : ''}${a.assigned_ready ? ` · ${a.assigned_ready} task${a.assigned_ready > 1 ? 's' : ''} waiting for it` : ''}`;
  }

  function renderPop() {
    const o = agents.get(selected);
    if (!o) return closePop();
    const a = o.data;
    const [st, label] = agentState(a);
    const win = a.usage_window_hours || 5;
    const meters = [a.turn_limit
      ? meter(`Turns in the last ${win}h`, a.turns_in_window, a.turn_limit, `${a.turns_in_window} / ${a.turn_limit}`)
      : `<div class="meter-row"><div class="meter-label"><span>Turns in the last ${win}h</span><span class="mono">${a.turns_in_window}</span></div></div>`];
    if (a.token_budget) meters.push(meter('Token budget used', a.tokens_total, a.token_budget, `${fmtNum(a.tokens_total)} / ${fmtNum(a.token_budget)}`));
    pop.innerHTML = `<div class="of-pop-head"><span class="of-dot" style="--c:${colorFor(a.id)}"></span><strong>${esc(a.display_name)}</strong>
        <span class="pill state-${st}">${esc(label)}</span><button class="of-x" data-office-close aria-label="Close">×</button></div>
      <div class="of-line">${doing(o)}</div>
      <div class="of-line"><span class="label">Last report</span>${a.last_summary ? esc(a.last_summary) + (a.last_summary_at ? ` <span class="muted small">· ${ago(a.last_summary_at)}</span>` : '') : '<span class="muted">No report yet</span>'}</div>
      ${meters.join('')}
      <div class="desk-actions">
        <button class="btn small primary" data-ping="${esc(a.id)}">Ping</button>
        <button class="btn small" data-give="${esc(a.id)}">Give task</button>
        ${a.wake_trigger_id && window.BOARD_WAKE ? `<button class="btn small" data-wake="${esc(a.id)}">Wake now</button>` : ''}
        <button class="btn small" data-office-more="${esc(a.id)}" aria-label="More options">⋯</button>
      </div>`;
    pop.classList.remove('hidden');
    placeFloating(pop, o, 22);
  }

  function select(o) {
    closeMenu();
    selected = o.id;
    for (const x of agents.values()) x.el.classList.toggle('selected', x === o);
    renderPop();
  }
  function closePop() {
    selected = '';
    pop.classList.add('hidden');
    for (const x of agents.values()) x.el.classList.remove('selected');
  }

  function openMenu(o, clientX, clientY) {
    menuFor = o.id;
    const a = o.data;
    const held = o.dragging || performance.now() < o.heldUntil;
    menu.innerHTML = `<div class="of-menu-head">${esc(a.display_name)}</div>
      <button role="menuitem" data-ping="${esc(a.id)}">Ping for a status report</button>
      <button role="menuitem" data-give="${esc(a.id)}">Give a task</button>
      ${a.wake_trigger_id && window.BOARD_WAKE ? `<button role="menuitem" data-wake="${esc(a.id)}">Wake now</button>` : ''}
      <button role="menuitem" data-office-msg="${esc(a.id)}">Send a message</button>
      <button role="menuitem" data-office-details="${esc(a.id)}">Show details</button>
      <hr>
      ${held ? `<button role="menuitem" data-office-release="${esc(a.id)}">Back to work</button>` : ''}
      <button role="menuitem" data-toggle-agent="${esc(a.id)}">${a.status === 'active' ? 'Pause' : 'Resume'}</button>
      <button role="menuitem" data-edit-agent="${esc(a.id)}">Settings</button>`;
    menu.classList.remove('hidden');
    const r = root.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = `${Math.max(6, Math.min(clientX - r.left, r.width - mw - 6))}px`;
    menu.style.top = `${Math.max(6, Math.min(clientY - r.top, r.height - mh - 6))}px`;
    const first = menu.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }
  function closeMenu() { menuFor = ''; menu.classList.add('hidden'); }

  // Place a floating panel next to an agent, inside the office. Narrow screens dock it below.
  function placeFloating(el, o, gap) {
    if (!o || el.classList.contains('hidden')) return;
    const r = root.getBoundingClientRect();
    const docked = r.width < 560;
    el.classList.toggle('docked', docked);
    if (docked) { el.style.left = el.style.top = ''; return; }
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const [sx, sy] = P(o.x, o.y);
    const px = ctm.a * sx + ctm.e - r.left, py = ctm.d * sy + ctm.f - r.top;
    const w = el.offsetWidth, h = el.offsetHeight;
    let top = py + gap;
    if (top + h > r.height - 6) top = py - 40 * ctm.d - h - 6;
    el.style.left = `${Math.max(6, Math.min(px - w / 2, r.width - w - 6))}px`;
    el.style.top = `${Math.max(6, top)}px`;
  }

  // ---------- input ----------

  function toFloor(clientX, clientY) {
    const ctm = svg.getScreenCTM();
    const sx = (clientX - ctm.e) / ctm.a, sy = (clientY - ctm.f) / ctm.d;
    const a = sx / C, b = sy / H;
    return { x: Math.max(0.35, Math.min(W - 0.35, (a + b) / 2)), y: Math.max(0.35, Math.min(D - 0.35, (b - a) / 2)) };
  }

  function bindEvents() {
    root.addEventListener('pointerdown', (e) => {
      if (!menu.contains(e.target)) closeMenu();
      const el = e.target.closest('.of-agent');
      if (!el) {
        if (!pop.contains(e.target) && !e.target.closest('.of-hot')) closePop();
        return;
      }
      const o = el.__agent;
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      drag = { o, id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, longFired: false, long: 0 };
      if (e.pointerType !== 'mouse') {
        drag.long = setTimeout(() => { if (drag && !drag.moved) { drag.longFired = true; openMenu(o, drag.x0, drag.y0); } }, 550);
      }
    });
    root.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const o = drag.o;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 6) {
        drag.moved = true;
        clearTimeout(drag.long);
        o.dragging = true;
        o.path = [];
        o.el.classList.add('dragging');
        setIcon(o, null);
        closeMenu();
      }
      if (drag.moved) {
        const p = toFloor(e.clientX, e.clientY);
        const dx = p.x - o.x, dy = p.y - o.y;
        if (Math.hypot(dx, dy) > 0.01) o.dir = [dx / Math.hypot(dx, dy), dy / Math.hypot(dx, dy)];
        o.x = p.x; o.y = p.y;
        start();
      }
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { o, moved, longFired } = drag;
      clearTimeout(drag.long);
      drag = null;
      if (moved) {
        o.dragging = false;
        o.el.classList.remove('dragging');
        o.heldUntil = performance.now() + 20000;
        o.dwellUntil = o.heldUntil;
        o.spot = 'held';
        o.event = null;
        if (Math.hypot(o.x - SPOTS.bulletin.x, o.y - SPOTS.bulletin.y) < 1.4 || (o.x < 1.4 && o.y > 2.2 && o.y < 5.3)) {
          setIcon(o, 'board');
          newTask({ assignee: o.id, role_tag: 'any' });
        }
        if (selected === o.id) renderPop();
      } else if (!longFired && e.type === 'pointerup') select(o);
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    root.addEventListener('contextmenu', (e) => {
      const el = e.target.closest('.of-agent');
      if (!el) return;
      e.preventDefault();
      openMenu(el.__agent, e.clientX, e.clientY);
    });
    root.addEventListener('keydown', (e) => {
      const el = e.target.closest('.of-agent');
      if (e.key === 'Escape') { if (menuFor) { const o = agents.get(menuFor); closeMenu(); if (o) o.el.focus(); } else closePop(); return; }
      if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(el.__agent); return; }
      if (el && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
        e.preventDefault();
        const b = el.getBoundingClientRect();
        openMenu(el.__agent, b.left + b.width / 2, b.bottom);
        return;
      }
      const hot = e.target.closest('.of-hot');
      if (hot && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); hot.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
      if (menuFor && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        const items = [...menu.querySelectorAll('button')];
        const i = items.indexOf(document.activeElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
        e.preventDefault();
      }
    });
    // Office-only actions; the shared ones (ping, give, wake, pause, settings, tasks) go to app.js.
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-office-close], [data-office-more], [data-office-msg], [data-office-details], [data-office-release]');
      if (!b) {
        if (menu.contains(e.target) && e.target.closest('button')) requestAnimationFrame(closeMenu);
        return;
      }
      const d = b.dataset;
      if (d.officeClose !== undefined) return closePop();
      if (d.officeMore) { const r = b.getBoundingClientRect(); return openMenu(agents.get(d.officeMore), r.left, r.bottom + 4); }
      closeMenu();
      if (d.officeMsg) return messageDialog(d.officeMsg);
      if (d.officeDetails) return select(agents.get(d.officeDetails));
      if (d.officeRelease) {
        const o = agents.get(d.officeRelease);
        o.heldUntil = 0; o.dwellUntil = 0;
        if (selected === o.id) renderPop();
      }
    });
    document.addEventListener('pointerdown', (e) => { if (root.isConnected && !root.contains(e.target)) closeMenu(); });
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-office-select]');
      if (!b || !root.isConnected) return;
      const o = agents.get(b.dataset.officeSelect);
      if (!o) return;
      root.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'nearest' });
      select(o);
    });
  }

  // ---------- public ----------

  return {
    attach(slot) {
      if (!slot) return;
      if (!root) init();
      slot.appendChild(root);
      update(state.snap);
      start();
    },
  };
})();
