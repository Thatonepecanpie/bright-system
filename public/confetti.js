// Confetti bursts for finished tasks. One shared canvas laid over the page; it only animates
// while pieces are in the air, and does nothing for people who prefer reduced motion.
'use strict';

const Confetti = (() => {
  const COLORS = ['#f4c84a', '#5b93f0', '#ef6f6c', '#5cc98b', '#b993f2', '#f59f4c'];
  let canvas, ctx, raf = 0, last = 0;
  let pieces = [];

  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function ensure() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.className = 'confetti';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  // Launch pieces upward from (x, y), in viewport pixels.
  function burst(x, y, { count = 90, colors = COLORS, power = 1, spread = 1 } = {}) {
    if (reduced()) return;
    ensure();
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.85 * spread;
      const speed = (380 + Math.random() * 420) * power;
      pieces.push({
        x, y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        w: 5 + Math.random() * 5, h: 7 + Math.random() * 6,
        rot: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 12,
        flutter: Math.random() * Math.PI * 2,
        color: colors[Math.floor(Math.random() * colors.length)],
        round: Math.random() < 0.25,
        age: 0, life: 1.6 + Math.random() * 0.9,
      });
    }
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
  }

  function tick(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    pieces = pieces.filter((p) => p.age < p.life && p.y < window.innerHeight + 30);
    for (const p of pieces) {
      p.age += dt;
      p.vy += 900 * dt;                 // gravity
      p.vx *= 1 - 1.6 * dt;             // air drag
      p.vy *= 1 - 1.2 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      p.flutter += 9 * dt;
      ctx.save();
      ctx.globalAlpha = Math.min(1, (p.life - p.age) / 0.4);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.scale(1, Math.cos(p.flutter));
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    }
    raf = pieces.length ? requestAnimationFrame(tick) : 0;
    if (!raf) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  return {
    burst,
    // Burst from the middle of an element, or from the top of the page if it is not on screen.
    fromElement(el, opts) {
      const r = el && el.getBoundingClientRect();
      if (r && r.width && r.bottom > 0 && r.top < window.innerHeight) burst(r.left + r.width / 2, r.top + r.height / 2, opts);
      else burst(window.innerWidth / 2, window.innerHeight * 0.3, opts);
    },
  };
})();
