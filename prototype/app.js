/*
 * Ephemeral text display prototype.
 *
 *  - Words arrive at the bottom and every line scrolls up at a slow, constant speed.
 *  - Above the pixelation start line (default: window middle) a line is progressively pixelated.
 *  - When a line reaches the dust zone near the top it breaks into grains that drift up and sideways and fade.
 *  - Nothing is stored: text lives only in the line objects below and is gone once its dust has faded.
 *    (Only display settings are stored in the browser (localStorage) - never text.)
 *
 * Test helpers via URL:  ?warp=SECONDS (pre-simulate)  &menu=1 (open the menu)  &light=1 (light theme)
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ settings
  const THEMES = {
    dark:  { fg: '#f2efe6', bg: '#0b0c10' },
    light: { fg: '#16181d', bg: '#f6f3ea' },
  };
  const DEFAULTS = {
    fg: THEMES.dark.fg,
    bg: THEMES.dark.bg,
    fontPx: 84,          // css px
    align: 'center',     // 'left' | 'center'
    speed: 28,           // css px/s, base scroll speed
    pixelStart: 0.5,     // fraction of window height from top where pixelation begins
    blockMax: 14,        // css px, largest pixel block (reached at the dust zone)
    dissolveZone: 0.14,  // fraction from top: a line starts breaking up when its middle crosses this
    wind: 60,            // css px/s sideways (negative = left)
    lift: 45,            // css px/s upward
    life: 2.4,           // s, grain lifetime
    span: 1.2,           // s, how long a line takes to break up completely
    wps: 2.5,            // simulated words per second
  };
  let cfg = Object.assign({}, DEFAULTS);
  let themeName = 'dark';

  const GRAIN = 2;       // each pixel block splits into GRAIN x GRAIN grains when released
  const CATCH_UP = 1.5;  // 1/s: extra scroll when text arrives faster than the base speed
  const FONT_FAMILY = '"Segoe UI Variable Display", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif';

  const params = new URLSearchParams(location.search);

  // ------------------------------------------------------------------ canvas + metrics
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { alpha: false });
  const mctx = document.createElement('canvas').getContext('2d');          // text measuring
  const tmp = document.createElement('canvas');                            // per-frame pixelation scratch
  const tctx = tmp.getContext('2d');
  const sampler = document.createElement('canvas');                        // dissolve-time pixel readback
  const sctx = sampler.getContext('2d', { willReadFrequently: true });

  let dpr = 1, W = 0, H = 0;
  let fontPx = 0, lineH = 0, margin = 0, maxTextW = 0, bottomSpot = 0, fontStr = '';
  let scrollV = 0;       // current scroll speed, device px/s
  let lines = [];

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rand = (a, b) => a + Math.random() * (b - a);

  function layout() {
    dpr = window.devicePixelRatio || 1;
    W = Math.max(1, Math.round(window.innerWidth * dpr));
    H = Math.max(1, Math.round(window.innerHeight * dpr));
    canvas.width = W;
    canvas.height = H;
    fontPx = Math.round(cfg.fontPx * dpr);
    lineH = Math.round(fontPx * 1.28);
    margin = Math.round(W * 0.06);
    maxTextW = W - 2 * margin;
    bottomSpot = H - lineH - Math.round(lineH * 0.3);
    fontStr = `600 ${fontPx}px ${FONT_FAMILY}`;
    // scratch canvases only ever hold downscaled (>= 2x) lines
    tmp.width = Math.ceil(W / 2) + 2;
    tmp.height = Math.ceil(lineH / 2) + 2;
    sampler.width = tmp.width;
    sampler.height = tmp.height;
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
  }

  // ------------------------------------------------------------------ lines
  function newLine(y) {
    const c = document.createElement('canvas');
    return {
      y, words: [], text: '', dirty: true,
      canvas: c, g: c.getContext('2d'),
      x0: 0, x1: 0,
      dissolving: false, t: 0, parts: [],
    };
  }

  function lastLive() {
    for (let i = lines.length - 1; i >= 0; i--) if (!lines[i].dissolving) return lines[i];
    return null;
  }

  /** Append a word to the last line, or start a new line just below it. */
  function addWord(word, reflowing) {
    mctx.font = fontStr;
    const line = lastLive();
    if (line) {
      const trial = line.text ? line.text + ' ' + word : word;
      if (!line.text || mctx.measureText(trial).width <= maxTextW) {
        line.words.push(word);
        line.text = trial;
        line.dirty = true;
        return;
      }
    }
    const prev = lines.length ? lines[lines.length - 1] : null;
    let y;
    if (reflowing) y = prev && !prev.dissolving ? prev.y + lineH : (reflowing.firstY ?? bottomSpot);
    else y = Math.max(prev ? prev.y + lineH : -Infinity, bottomSpot);
    const nl = newLine(y);
    nl.words.push(word);
    nl.text = word;
    lines.push(nl);
  }

  /** Re-wrap all live text (after a resize or font-size change), keeping the first line where it is. */
  function reflow() {
    const live = lines.filter((l) => !l.dissolving);
    const words = live.flatMap((l) => l.words);
    const ctxInfo = { firstY: live.length ? live[0].y : undefined };
    lines = lines.filter((l) => l.dissolving);
    for (const w of words) addWord(w, ctxInfo);
  }

  function redraw(line) {
    const c = line.canvas;
    if (c.width !== W || c.height !== lineH) { c.width = W; c.height = lineH; }
    const g = line.g;
    g.clearRect(0, 0, W, lineH);
    g.font = fontStr;
    g.textBaseline = 'alphabetic';
    g.fillStyle = cfg.fg;
    const w = g.measureText(line.text).width;
    const x = cfg.align === 'left' ? margin : Math.round((W - w) / 2);
    g.fillText(line.text, x, Math.round(lineH / 2 + fontPx * 0.34));
    line.x0 = x;
    line.x1 = x + w;
    line.dirty = false;
  }

  // ------------------------------------------------------------------ pixelation
  const bMax = () => Math.max(2, Math.round(cfg.blockMax * dpr));

  /** Pixel block size (device px) for a line at its current height. 1 = crisp. */
  function blockFor(line) {
    const mid = line.y + lineH / 2;
    const start = H * cfg.pixelStart;
    const end = H * cfg.dissolveZone;
    if (mid >= start || start <= end) return 1;
    const t = clamp((start - mid) / (start - end), 0, 1);
    return Math.max(1, Math.round(1 + (bMax() - 1) * Math.pow(t, 1.3)));
  }

  /** Crop of the line canvas (grid-aligned to block size b) that contains its text. */
  function crop(line, b) {
    const pad = b * 2;
    const sx = Math.max(0, Math.floor((line.x0 - pad) / b) * b);
    const ex = Math.min(W, Math.ceil((line.x1 + pad) / b) * b);
    return { sx, sw: ex - sx, cw: Math.ceil((ex - sx) / b), ch: Math.ceil(lineH / b) };
  }

  function drawLine(line) {
    const y = Math.round(line.y);
    if (!line.text || y >= H || y + lineH <= 0) return;
    if (line.dirty) redraw(line);
    const b = blockFor(line);
    const { sx, sw, cw, ch } = crop(line, b);
    if (sw <= 0) return;
    if (b === 1) {
      ctx.drawImage(line.canvas, sx, 0, sw, lineH, sx, y, sw, lineH);
      return;
    }
    tctx.clearRect(0, 0, cw, ch);
    tctx.drawImage(line.canvas, sx, 0, sw, lineH, 0, 0, cw, ch);   // downscale = average colour per block
    ctx.drawImage(tmp, 0, 0, cw, ch, sx, y, cw * b, ch * b);        // upscale without smoothing = hard pixels
  }

  // ------------------------------------------------------------------ dust
  function startDissolve(line) {
    if (line.dirty) redraw(line);
    line.dissolving = true;
    line.t = 0;
    const b = bMax();
    const { sx, sw, cw, ch } = crop(line, b);
    sctx.clearRect(0, 0, cw, ch);
    sctx.drawImage(line.canvas, sx, 0, sw, lineH, 0, 0, cw, ch);
    const data = sctx.getImageData(0, 0, cw, ch).data;
    const dir = cfg.wind >= 0 ? 1 : -1;
    const spanX = Math.max(1, line.x1 - line.x0);
    const parts = [];
    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        const a = data[(cy * cw + cx) * 4 + 3];
        if (a < 24) continue;
        const lx = sx + cx * b;
        // Erode in the direction the wind blows, with plenty of randomness.
        let frac = clamp((lx - line.x0) / spanX, 0, 1);
        if (dir < 0) frac = 1 - frac;
        parts.push({
          out: false, lx, ly: cy * b, b, a: a / 255,
          rel: cfg.span * (0.45 * Math.random() + 0.55 * frac * Math.random() + 0.1 * frac),
          x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 1, ph: 0,
        });
      }
    }
    line.parts = parts;
    line.canvas.width = line.canvas.height = 1;   // pixels now live in the particles; free the bitmap
  }

  function releaseCell(p, line, out) {
    const g = p.b / GRAIN;
    const baseY = Math.round(line.y) + p.ly;
    for (let gy = 0; gy < GRAIN; gy++) {
      for (let gx = 0; gx < GRAIN; gx++) {
        out.push({
          out: true, b: g, a: p.a,
          x: p.lx + gx * g, y: baseY + gy * g,
          vx: cfg.wind * dpr * rand(0.4, 1.3) + rand(-15, 15) * dpr,
          vy: -cfg.lift * dpr * rand(0.3, 1.4) + rand(-10, 10) * dpr,
          age: 0, life: cfg.life * rand(0.6, 1.4), ph: rand(0, 6.28),
        });
      }
    }
  }

  function updateParticles(line, dt) {
    line.t += dt;
    const parts = line.parts;
    const born = [];
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (!p.out) {
        if (line.t >= p.rel) {
          releaseCell(p, line, born);
          parts[i] = parts[parts.length - 1];
          parts.pop();
        }
        continue;
      }
      p.age += dt;
      if (p.age >= p.life || p.y < -p.b * 4) {
        parts[i] = parts[parts.length - 1];
        parts.pop();
        continue;
      }
      p.x += (p.vx + Math.sin(p.age * 3 + p.ph) * 12 * dpr) * dt;
      p.y += (p.vy - scrollV) * dt;
    }
    for (const p of born) parts.push(p);
  }

  function drawParticles(line) {
    const baseY = Math.round(line.y);
    for (const p of line.parts) {
      if (!p.out) {
        ctx.globalAlpha = p.a;
        ctx.fillRect(p.lx, baseY + p.ly, p.b, p.b);
      } else {
        const f = 1 - p.age / p.life;
        ctx.globalAlpha = p.a * f * f;
        const s = p.b * (0.3 + 0.7 * f);
        ctx.fillRect(p.x, p.y, s, s);
      }
    }
  }

  // ------------------------------------------------------------------ simulation + render
  const feed = new window.SimulatedFeed();

  function step(dt) {
    feed.wps = cfg.wps;
    feed.tick(dt, (w) => addWord(w));

    const last = lastLive();
    scrollV = cfg.speed * dpr + (last ? Math.max(0, last.y - bottomSpot) * CATCH_UP : 0);
    const dissolveY = H * cfg.dissolveZone;

    for (const l of lines) {
      l.y -= scrollV * dt;
      if (!l.dissolving && l.text && l.y + lineH / 2 < dissolveY) startDissolve(l);
      if (l.dissolving) updateParticles(l, dt);
    }
    if (lines.some((l) => l.dissolving && l.parts.length === 0)) {
      lines = lines.filter((l) => !(l.dissolving && l.parts.length === 0));
    }
  }

  function render() {
    ctx.globalAlpha = 1;
    ctx.fillStyle = cfg.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    for (const l of lines) if (!l.dissolving) drawLine(l);
    ctx.fillStyle = cfg.fg;
    for (const l of lines) if (l.dissolving) drawParticles(l);
    ctx.globalAlpha = 1;
  }

  let lastT = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    step(dt);
    render();
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ settings menu
  const menu = document.getElementById('menu');
  const root = document.documentElement;
  const keyEls = [...menu.querySelectorAll('[data-key]')];
  const themeBtns = [...menu.querySelectorAll('[data-theme]')];
  const alignBtns = [...menu.querySelectorAll('[data-align]')];
  const pauseBtn = document.getElementById('btn-pause');

  function fmt(el, v) {
    switch (el.dataset.unit) {
      case '%top': return Math.round(v * 100) + '%';
      case 'wps': return Number(v).toFixed(1);
      case 's': return Number(v).toFixed(1) + 's';
      default: return v + (el.dataset.unit || '');
    }
  }

  function applyColors() {
    root.style.setProperty('--fg', cfg.fg);
    root.style.setProperty('--bg', cfg.bg);
    for (const l of lines) l.dirty = true;
  }

  function syncUI() {
    for (const el of keyEls) {
      el.value = cfg[el.dataset.key];
      const out = el.parentElement.querySelector('output');
      if (out) out.textContent = fmt(el, cfg[el.dataset.key]);
    }
    for (const b of themeBtns) b.setAttribute('aria-pressed', String(b.dataset.theme === themeName));
    for (const b of alignBtns) b.setAttribute('aria-pressed', String(b.dataset.align === cfg.align));
    pauseBtn.textContent = feed.paused ? 'Resume' : 'Pause';
  }

  // Display settings only (never text). Every storage access is guarded: it may be blocked or empty.
  const STORE_KEY = 'ghost-echo.prototype.settings';
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ cfg, themeName })); } catch (e) { /* storage unavailable */ }
  }
  function clearSettings() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
  }
  /** Returns the saved themeName if settings were restored, else null. Unknown keys / bad values are ignored. */
  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!saved || typeof saved.cfg !== 'object' || !saved.cfg) return null;
      for (const key of Object.keys(DEFAULTS)) {
        const v = saved.cfg[key];
        if (typeof v !== typeof DEFAULTS[key]) continue;
        if (typeof v === 'number' && !Number.isFinite(v)) continue;
        if (key === 'fg' || key === 'bg') { if (!/^#[0-9a-f]{6}$/i.test(v)) continue; }
        if (key === 'align' && v !== 'left' && v !== 'center') continue;
        cfg[key] = v;
      }
      return saved.themeName === 'light' || saved.themeName === 'dark' ? saved.themeName : 'custom';
    } catch (e) { return null; }
  }

  function setTheme(name) {
    themeName = name;
    cfg.fg = THEMES[name].fg;
    cfg.bg = THEMES[name].bg;
    applyColors();
    syncUI();
    saveSettings();
  }

  for (const el of keyEls) {
    el.addEventListener('input', () => {
      const key = el.dataset.key;
      if (el.type === 'color') {
        cfg[key] = el.value;
        themeName = 'custom';          // colors no longer match a preset
        applyColors();
      } else {
        cfg[key] = parseFloat(el.value);
        if (key === 'fontPx') { layout(); reflow(); }
      }
      const out = el.parentElement.querySelector('output');
      if (out) out.textContent = fmt(el, cfg[key]);
      for (const b of themeBtns) b.setAttribute('aria-pressed', String(b.dataset.theme === themeName));
      saveSettings();
    });
  }
  for (const b of themeBtns) b.addEventListener('click', () => setTheme(b.dataset.theme));
  for (const b of alignBtns) {
    b.addEventListener('click', () => {
      cfg.align = b.dataset.align;
      for (const l of lines) l.dirty = true;
      syncUI();
      saveSettings();
    });
  }
  function togglePause() { feed.paused = !feed.paused; syncUI(); }
  pauseBtn.addEventListener('click', togglePause);
  document.getElementById('btn-clear').addEventListener('click', () => { lines = []; });
  document.getElementById('btn-reset').addEventListener('click', () => {
    cfg = Object.assign({}, DEFAULTS);
    clearSettings();
    setTheme(initialTheme());
    clearSettings();     // reset means "no saved settings", not "save the defaults"
    layout();
    reflow();
    syncUI();
  });

  // Menu visibility: appears when the pointer reaches the right edge; M toggles (and pins) it.
  const EDGE_PX = 72;
  let menuOpen = false, pinned = false, closeTimer = 0, idleTimer = 0;

  function setMenu(open) {
    menuOpen = open;
    menu.classList.toggle('open', open);
    if (open) menu.removeAttribute('inert'); else menu.setAttribute('inert', '');
  }
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!menuOpen) document.body.classList.add('idle'); }, 2500);
  }
  document.addEventListener('pointermove', (e) => {
    wake();
    const inZone = e.clientX >= window.innerWidth - (menuOpen ? menu.offsetWidth : EDGE_PX);
    if (inZone) {
      clearTimeout(closeTimer);
      closeTimer = 0;
      if (!menuOpen) setMenu(true);
    } else if (menuOpen && !pinned && !closeTimer) {
      closeTimer = setTimeout(() => { closeTimer = 0; setMenu(false); }, 600);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'm' || e.key === 'M') {
      pinned = !menuOpen;
      setMenu(!menuOpen);
      if (menuOpen) menu.querySelector('button, input')?.focus();
      else document.activeElement?.blur();
    } else if (e.key === 'Escape' && menuOpen) {
      pinned = false;
      setMenu(false);
      document.activeElement?.blur();
    } else if (e.key === ' ' && e.target === document.body) {
      e.preventDefault();
      togglePause();
    }
  });

  // ------------------------------------------------------------------ init
  function initialTheme() {
    if (params.get('light') === '1') return 'light';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { layout(); reflow(); });
  });

  const restored = params.get('light') === '1' ? null : loadSettings();
  layout();
  if (restored) {
    themeName = restored;
    applyColors();
    syncUI();
  } else {
    setTheme(initialTheme());
    clearSettings();     // nothing was saved by the user yet; don't store the auto-picked theme
  }
  wake();
  if (params.get('menu') === '1') { pinned = true; setMenu(true); }

  const warp = parseFloat(params.get('warp') || '0');
  for (let t = 0; t < warp; t += 1 / 30) step(1 / 30);

  requestAnimationFrame((t) => { lastT = t; frame(t); });
})();
