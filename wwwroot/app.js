/*
 * Ghost Echo display: ephemeral text rendering + display settings menu.
 * (client.js owns the microphone / WebSocket and drives this through window.Display.)
 *
 *  - Words arrive at the bottom and every line scrolls up at a slow, constant speed.
 *  - Above the pixelation start line (default: window middle) a line is progressively pixelated.
 *  - When a line reaches the dust zone near the top it breaks into grains that drift up and sideways and fade.
 *  - Nothing is stored: text lives only in the line objects below. It is wiped the moment a line starts to
 *    dissolve, and no line may outlive RetentionSeconds (set by the server) after its last update.
 *    (Only display settings are stored in the browser (localStorage) - never text.)
 *
 * Test helpers via URL:  &menu=1 (open the menu)  &light=1 (light theme)  &debug=1 (console warnings if the newest line moves down)
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ settings
  const THEMES = {
    dark:  { fg: '#f2efe6', bg: '#0b0c10' },
    light: { fg: '#16181d', bg: '#f6f3ea' },
    sepia: { fg: '#5F4B32', bg: '#FBF0D9' },
  };
  const DEFAULTS = {
    fg: THEMES.dark.fg,
    bg: THEMES.dark.bg,
    fontPx: 84,          // css px
    speed: 28,           // css px/s, base scroll speed
    pixelStart: 0.5,     // fraction of window height from top where pixelation begins
    blockMax: 14,        // css px, largest pixel block (reached at the dust zone)
    dissolveZone: 0.14,  // fraction from top: a line starts breaking up when its middle crosses this
    wind: 60,            // css px/s sideways (negative = left)
    lift: 45,            // css px/s upward
    life: 2.4,           // s, grain lifetime
    span: 1.2,           // s, how long a line takes to break up completely
    mic: '',             // selected microphone deviceId ('' = default)
  };
  let cfg = Object.assign({}, DEFAULTS);
  let themeName = 'dark';

  const INTRO_WPS = 3.2;  // pace of the intro phrase, words per second
  const MAX_SCROLL = 450;   // css px/s, cap on catch-up scrolling
  const SCROLL_ACCEL = 300; // css px/s^2
  const SCROLL_DECEL = 150; // css px/s^2
  const GAP_SECONDS = 2;    // silence longer than this leaves a gap before the next line
  const GRAIN = 2;       // each pixel block splits into GRAIN x GRAIN grains when released
  const ADAPT_RATE = 1.2;  // 1/s per line-height of error: how fast the base speed adapts (log scale)
  const RETENTION_MARGIN = 0.85;  // lines must reach the dust zone within this fraction of their remaining retention
  const ADAPT_MIN =0.01, ADAPT_MAX = 6;
  const CATCH_UP = 1.5; // 1/s: extra scroll when text arrives faster than the base speed
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
  let speedAdapt = 1;    // multiplier on cfg.speed, learned every frame from where the newest line sits (see step)
  let lines = [];
  let lastWordClock = 0;  // clock time of the previous addWord
  let clock = 0;         // seconds of animation time; used for retention
  let align = 'left';    // 'left' | 'center'; set by the server's Ui:Align (not a UI setting)
  let retentionSeconds = 60;    // set by the server's Whisper:RetentionSeconds (not a UI setting)
  const FONT_STEPS = 8;
  let fontSizes = makeFontSizes(38, 156);  // the selectable text sizes (px); range comes from the server's Ui:FontMinPx / FontMaxPx
  let anchorY = null;    // where the last line removed by dropTail was; the replacement line starts there, not at the bottom slot

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
      y, words: [], text: '', dirty: true, touched: clock,
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
    const sinceLastWord = clock - lastWordClock;
    lastWordClock = clock;
    const line = lastLive();
    if (line) {
      const trial = line.text ? line.text + ' ' + word : word;
      if (!line.text || textWidth(mctx, trial) <= maxTextW) {
        line.words.push(word);
        line.text = trial;
        line.dirty = true;
        line.touched = clock;
        return;
      }
    }
    const prev = lines.length ? lines[lines.length - 1] : null;
    let y;
    if (reflowing) y = prev && !prev.dissolving ? prev.y + lineH : (reflowing.firstY ?? bottomSpot);
    // New lines follow the previous live line directly, so text is never split by layout. The one exception is
    // a real pause in the audio (GAP_SECONDS without a new word): then the new line starts at the bottom slot,
    // leaving a visible gap that mirrors the silence. Replacing a line (anchorY) never opens a gap.
    else if (prev && !prev.dissolving) {
      y = prev.y + lineH;
      if (anchorY === null && sinceLastWord > GAP_SECONDS) y = Math.max(y, bottomSpot);
    } else y = anchorY !== null ? anchorY : bottomSpot;
    anchorY = null;
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

  // The server replaces each letter of a forbidden word with MASK (see ProfanityFilter.cs); a run of them is drawn
  // as a fixed mosaic instead of text, so the word itself never reaches the browser.
  const MASK = '';
  const MASK_RUN = /+/g;
  const MASK_ADV = 0.5;   // advance per masked letter, in font sizes

  /** Width of a string in device px, counting each mask run as a mosaic block. */
  function textWidth(g, s) {
    let w = 0, last = 0;
    for (const m of s.matchAll(MASK_RUN)) {
      w += g.measureText(s.slice(last, m.index)).width + m[0].length * MASK_ADV * fontPx;
      last = m.index + m[0].length;
    }
    return w + g.measureText(s.slice(last)).width;
  }

  /** Deterministic 0..1 noise so a mosaic never flickers between redraws. */
  const cellNoise = (i, j) => { const n = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return n - Math.floor(n); };

  function drawMosaic(g, x, base, n) {
    const w = n * MASK_ADV * fontPx;
    const cell = Math.max(3, Math.round(fontPx / 7));
    const top = base - Math.round(fontPx * 0.72);
    const x0 = x + Math.round(fontPx * 0.04);
    const cols = Math.max(1, Math.round((w - fontPx * 0.08) / cell));
    const rows = Math.max(1, Math.round((base - top) / cell));
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        g.globalAlpha = 0.3 + 0.7 * cellNoise(i, j);
        g.fillRect(x0 + i * cell, top + j * cell, cell, cell);
      }
    }
    g.globalAlpha = 1;
  }

  function drawRichText(g, s, x, base) {
    let last = 0;
    const plain = (t) => { if (t) { g.fillText(t, x, base); x += g.measureText(t).width; } };
    for (const m of s.matchAll(MASK_RUN)) {
      plain(s.slice(last, m.index));
      drawMosaic(g, x, base, m[0].length);
      x += m[0].length * MASK_ADV * fontPx;
      last = m.index + m[0].length;
    }
    plain(s.slice(last));
  }

  function redraw(line) {
    const c = line.canvas;
    if (c.width !== W || c.height !== lineH) { c.width = W; c.height = lineH; }
    const g = line.g;
    g.clearRect(0, 0, W, lineH);
    g.font = fontStr;
    g.textBaseline = 'alphabetic';
    g.fillStyle = cfg.fg;
    const w = textWidth(g, line.text);
    const x = align === 'left' ? margin : Math.round((W - w) / 2);
    drawRichText(g, line.text, x, Math.round(lineH / 2 + fontPx * 0.34));
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
    line.words = [];                              // the text itself is gone from memory from here on
    line.text = '';
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

  // ------------------------------------------------------------------ incoming text
  const wordsOf = (text) => text.split(/\s+/).filter(Boolean);
  let pending = 0;            // words at the tail that belong to the current (not yet final) segment
  let introQueue = [];
  let introWait = 0.4;
  let held = [];              // transcript updates that arrived while the intro is still being "spoken"

  /** Remove the last n words of live text (they are about to be replaced by a newer partial). */
  function dropTail(n) {
    while (n > 0) {
      const line = lastLive();
      if (!line) return;
      const k = Math.min(n, line.words.length);
      line.words.length -= k;
      n -= k;
      if (line.words.length === 0) {
        anchorY = line.y;
        lines.splice(lines.indexOf(line), 1);
      } else {
        line.text = line.words.join(' ');
        line.dirty = true;
      }
    }
  }

  // Incoming words are not dumped on screen at once (a long partial would add many lines in one frame and make
  // the scroll lurch). The current segment's tail is revealed word by word toward `want`, faster when behind.
  let want = [];              // words the current segment should show
  let wantFinal = false;      // true once the segment is final (reveal must finish, then it is committed)
  let tailWords = [];         // words of the current segment already on screen (the replaceable tail)
  const REVEAL_WPS = 7, REVEAL_CATCH_UP = 1.5;
  let revealBudget = 0;

  function commitTail() { pending = 0; tailWords = []; want = []; wantFinal = false; anchorY = null; }

  /** Show all remaining wanted words immediately. */
  function finishReveal() {
    while (tailWords.length < want.length) { const w = want[tailWords.length]; tailWords.push(w); addWord(w); }
    pending = tailWords.length;
    if (wantFinal) commitTail();
  }

  // Partials often differ from the previous one only in case or punctuation ("American." vs "american,"):
  // for those, keep the word already on screen instead of redrawing it. A final must match exactly, so its
  // punctuation is correct.
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const sameWord = (shown, next, exact) => shown === next || (!exact && norm(shown) !== '' && norm(shown) === norm(next));

  function applyTranscript(text, final) {
    if (wantFinal) finishReveal();                 // an earlier final must be fully shown before a new segment starts
    anchorY = null;
    const next = wordsOf(text);
    const shownBefore = tailWords.length;
    let cp = 0;                                    // keep the words that did not change
    while (cp < tailWords.length && cp < next.length && sameWord(tailWords[cp], next[cp], final)) cp++;
    if (tailWords.length > cp) {                   // the model revised earlier words: take back the changed tail
      pending = tailWords.length;
      dropTail(tailWords.length - cp);
      tailWords.length = cp;
      pending = cp;
    }
    want = next;
    wantFinal = final;
    // Words that were already on screen are put straight back (revised in place) so text never vanishes and
    // is re-typed; only genuinely new words, beyond what was shown, are revealed at the paced rate.
    const keep = Math.min(next.length, shownBefore);
    while (tailWords.length < keep) { const w = next[tailWords.length]; tailWords.push(w); addWord(w); }
    pending = tailWords.length;
    if (tailWords.length >= want.length && final) commitTail();
  }

  /** Queue an update that arrived while the intro is still scrolling. A partial is superseded by whatever follows it. */
  function hold(text, final) {
    if (held.length && !held[held.length - 1].final) held.pop();
    held.push({ text, final });
  }

  function revealStep(dt) {
    if (tailWords.length >= want.length) return;
    const behind = want.length - tailWords.length;
    revealBudget += dt * Math.max(REVEAL_WPS, behind * REVEAL_CATCH_UP);
    while (revealBudget >= 1 && tailWords.length < want.length) {
      revealBudget -= 1;
      const w = want[tailWords.length];
      tailWords.push(w);
      addWord(w);
      pending = tailWords.length;
    }
    if (tailWords.length >= want.length) { revealBudget = 0; anchorY = null; if (wantFinal) commitTail(); }
  }

  // ?debug=1: warn in the console when the newest line moves down (it should only ever move up).
  // Logs positions only - never text.
  const DEBUG = params.get('debug') === '1';
  let dbgLine = null, dbgY = 0;
  function debugJumps(last, dt) {
    if (last && last === dbgLine) {
      const dy = (last.y - dbgY) / dpr;
      if (dy > 0.5) console.warn('newest line moved DOWN by ' + dy.toFixed(1) + 'px (pending=' + pending + ')');
    } else if (last && dbgLine) {
      console.info('newest line replaced: y ' + (dbgY / dpr).toFixed(0) + ' -> ' + (last.y / dpr).toFixed(0) + 'px');
    }
    dbgLine = last;
    dbgY = last ? last.y - scrollV * dt : 0;   // where it should be after this frame's scroll
  }

  let lineSeq = 0;
  function debugTrace() {   // window.__trace: per frame, [id, y(css px), nWords] of each live line (no text)
    const tr = (window.__trace = window.__trace || []);
    if (tr.length > 6000) return;
    tr.push({ t: +clock.toFixed(3), sv: +(scrollV / dpr).toFixed(1), ad: +speedAdapt.toFixed(3),
      err: lastLive() ? +((lastLive().y - bottomSpot) / lineH).toFixed(2) : null, L: lines.filter((l) => !l.dissolving)
      .map((l) => [l.id || (l.id = ++lineSeq), +(l.y / dpr).toFixed(1), l.words.length]) });
  }

  function step(dt) {
    clock += dt;

    if (introQueue.length) {
      introWait -= dt;
      while (introWait <= 0 && introQueue.length) {
        const w = introQueue.shift();
        addWord(w);
        introWait += (1 / INTRO_WPS) * (0.75 + 0.5 * Math.random()) * (/[.,;]$/.test(w) ? 1.8 : 1);
      }
    } else if (held.length) {
      // One held update at a time, each fully revealed (at the paced rate) before the next starts.
      if (tailWords.length >= want.length && !wantFinal) { const u = held.shift(); applyTranscript(u.text, u.final); }
    }

    if (!introQueue.length) revealStep(dt);

    const last = lastLive();
    // Feedback, every frame: the newest line sitting above the bottom slot means we scroll too fast for this text
    // size and speech rate (slow down); below it means too slow (speed up). Error is in line heights. Skipped
    // during silence, when text legitimately stays where it is.
    const dissolveY = H * cfg.dissolveZone;
    // Retention floor: no line may reach the age limit before it has scrolled up into the dust zone, otherwise it
    // would pixelate and vanish mid-screen. Use the speed each live line needs to get there in time (with margin).
    let floorV = 0;
    for (const l of lines) {
      if (l.dissolving || !l.text) continue;
      const remaining = Math.max(0.5, (retentionSeconds - (clock - l.touched)) * RETENTION_MARGIN);
      floorV = Math.max(floorV, (l.y + lineH / 2 - dissolveY) / remaining);
    }
    const baseV = cfg.speed * speedAdapt * dpr;
    // While the floor is what sets the speed, don't let the feedback keep winding the base speed down.
    if (last && lineH > 0 && clock - lastWordClock <= GAP_SECONDS) {
      const err = clamp((last.y - bottomSpot) / lineH, -3, 3);
      if (err > 0 || baseV > floorV) speedAdapt = clamp(speedAdapt * Math.exp(ADAPT_RATE * err * dt), ADAPT_MIN, ADAPT_MAX);
    }
    const target = Math.min(Math.max(baseV + (last ? Math.max(0, last.y - bottomSpot) * CATCH_UP : 0), floorV), MAX_SCROLL * dpr);
    // Ease toward the target speed so the scroll never lurches when text is added or replaced.
    scrollV += clamp(target - scrollV, -SCROLL_DECEL * dpr * dt, SCROLL_ACCEL * dpr * dt);
    if (anchorY !== null) anchorY -= scrollV * dt;
    if (DEBUG) { debugJumps(last, dt); debugTrace(); }

    for (const l of lines) {
      l.y -= scrollV * dt;
      if (!l.dissolving && l.text &&
          (l.y + lineH / 2 < dissolveY || clock - l.touched > retentionSeconds)) startDissolve(l);
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

  function fmt(el, v) {
    switch (el.dataset.unit) {
      case '%top': return Math.round(v * 100) + '%';
      case 'wps': return Number(v).toFixed(1);
      case 's': return Number(v).toFixed(1) + 's';
      default: return v + (el.dataset.unit || '');
    }
  }

  /** FONT_STEPS sizes spaced geometrically (equal perceived steps) from min to max, rounded to whole px. */
  function makeFontSizes(min, max) {
    return Array.from({ length: FONT_STEPS }, (_, i) => Math.round(min * Math.pow(max / min, i / (FONT_STEPS - 1))));
  }
  function nearestSize(px) {
    let best = 0;
    for (let i = 1; i < fontSizes.length; i++) if (Math.abs(fontSizes[i] - px) < Math.abs(fontSizes[best] - px)) best = i;
    return best;
  }
  const fontEl = document.getElementById('font-size');

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
    fontEl.value = nearestSize(cfg.fontPx);
    fontEl.parentElement.querySelector('output').textContent = fontSizes[nearestSize(cfg.fontPx)] + 'px';
    for (const b of themeBtns) b.setAttribute('aria-pressed', String(b.dataset.theme === themeName));
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
        cfg[key] = v;
      }
      return saved.themeName in THEMES ? saved.themeName : 'custom';
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
      }
      const out = el.parentElement.querySelector('output');
      if (out) out.textContent = fmt(el, cfg[key]);
      for (const b of themeBtns) b.setAttribute('aria-pressed', String(b.dataset.theme === themeName));
      saveSettings();
    });
  }
  fontEl.addEventListener('input', () => {
    cfg.fontPx = fontSizes[parseInt(fontEl.value, 10)];
    fontEl.parentElement.querySelector('output').textContent = cfg.fontPx + 'px';
    layout();
    reflow();
    saveSettings();
  });
  for (const b of themeBtns) b.addEventListener('click', () => setTheme(b.dataset.theme));
  document.getElementById('btn-clear').addEventListener('click', () => { lines = []; held = []; introQueue = []; commitTail(); });
  document.getElementById('btn-reset').addEventListener('click', () => {
    cfg = Object.assign({}, DEFAULTS);
    cfg.fontPx = fontSizes[nearestSize(cfg.fontPx)];
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
  cfg.fontPx = fontSizes[nearestSize(cfg.fontPx)];   // a saved size from another range snaps to the nearest step
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

  window.Display = {
    /** Live (in-progress) transcript for the current segment; replaces the previous partial. */
    partial(text) { if (introQueue.length || held.length) hold(text, false); else applyTranscript(text, false); },
    /** Finished segment; replaces the previous partial and is not touched again. */
    final(text) { if (introQueue.length || held.length) hold(text, true); else applyTranscript(text, true); },
    /** Scrolls a fixed phrase in word by word, like speech. */
    intro(text) { introQueue = wordsOf(text || ''); introWait = 0.4; },
    setRetention(sec) { if (sec > 0) retentionSeconds = sec; },
    /** Server's Ui:FontMinPx / FontMaxPx: the text-size slider offers FONT_STEPS sizes between them. */
    setFontRange(min, max) {
      if (!(min >= 8 && max > min && max <= 600)) return;
      fontSizes = makeFontSizes(min, max);
      cfg.fontPx = fontSizes[nearestSize(cfg.fontPx)];
      syncUI();
      layout();
      reflow();
    },
    /** Server's Ui:Align ('left' | 'center'); anything else means left. */
    setAlign(a) { align = a === 'center' ? 'center' : 'left'; for (const l of lines) l.dirty = true; },
    /** Wipe everything on screen (e.g. when listening stops is NOT done; text just ages out). */
    clear() { lines = []; held = []; introQueue = []; commitTail(); },
    /** The current segment is over without a final (connection dropped): stop treating its words as replaceable. */
    endSegment() { finishReveal(); commitTail(); },
    get(key) { return cfg[key]; },
    set(key, value) { cfg[key] = value; saveSettings(); },
  };

  requestAnimationFrame((t) => { lastT = t; frame(t); });
})();
