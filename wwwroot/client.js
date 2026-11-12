/*
 * Microphone + WebSocket client. Captures the mic, streams 16 kHz mono Int16 PCM to /ws, and hands
 * partial/final transcripts to the display (app.js). Privacy: audio is only ever held in transit-sized
 * frames; transcript text goes straight to the display and is never stored (no storage APIs are used
 * here except for the non-content "selected microphone" setting, via Display.set).
 *
 * Test helper via URL:  &autostart=1 (start listening without a click; needs mic permission already granted
 * or a browser launched with a fake audio device).
 */
(function () {
  'use strict';

  const FALLBACK_INTRO = 'Everything said in this room is heard once, written down for a moment, and then let go. Nothing here is saved.';
  const NO_SERVER = 'Could not reach the server, or no model is loaded (see README).';
  const statusEl = document.getElementById('status');
  const listenBtn = document.getElementById('btn-listen');
  const micSel = document.getElementById('sel-mic');
  const modelSel = document.getElementById('sel-model');
  const params = new URLSearchParams(location.search);

  let state = 'idle';            // 'idle' | 'starting' | 'listening' | 'stopping'
  let ws = null, stream = null, ctx = null, node = null, activeModel = '';
  let stopWaiter = null;

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }
  function setState(s) {
    state = s;
    listenBtn.textContent = s === 'listening' ? 'Stop listening' : 'Start listening';
    listenBtn.disabled = s === 'starting' || s === 'stopping';
  }

  // ---------------------------------------------------------------- start / stop
  async function start() {
    if (state !== 'idle') return;
    setState('starting');
    setStatus('Connecting…');
    try {
      await openSocket();
      await openMic();
    } catch (err) {
      await teardown();
      setState('idle');
      setStatus(err.message || String(err), 'error');
      return;
    }
    setState('listening');
    setStatus('Listening · Nothing saved.', 'live');
    refreshMics();   // device labels are only available after permission is granted
  }

  function openSocket() {
    return new Promise((resolve, reject) => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(scheme + '://' + location.host + '/ws');
      sock.binaryType = 'arraybuffer';
      let ready = false;
      sock.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'ready') {
          ready = true;
          activeModel = m.model;
          window.Display.setRetention(m.retentionSeconds);
          resolve();
        } else if (m.type === 'partial') {
          window.Display.partial(m.text || '');
        } else if (m.type === 'final') {
          window.Display.final(m.text || '');
          if (stopWaiter) stopWaiter();
        }
      };
      sock.onerror = () => { if (!ready) reject(new Error(NO_SERVER)); };
      sock.onclose = () => {
        if (!ready) { reject(new Error(NO_SERVER)); return; }
        if (ws === sock) {                       // dropped while we were still using it
          ws = null;
          window.Display.endSegment();
          if (state === 'listening') {
            teardown();
            setState('idle');
            setStatus('Connection lost. Click to listen again.', 'error');
          }
        }
      };
      ws = sock;
    });
  }

  async function openMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone access needs localhost or HTTPS.');
    }
    const id = window.Display.get('mic');
    const base = { channelCount: 1, echoCancellation: true, noiseSuppression: true };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: id ? Object.assign({}, base, { deviceId: { exact: id } }) : base });
    } catch (err) {
      if (id && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        window.Display.set('mic', '');           // saved microphone is gone; use the default
        stream = await navigator.mediaDevices.getUserMedia({ audio: base });
      } else if (err.name === 'NotAllowedError') {
        throw new Error('Microphone permission was denied.');
      } else {
        throw new Error('Microphone error: ' + (err.message || err.name));
      }
    }
    ctx = new AudioContext();
    await ctx.resume();
    await ctx.audioWorklet.addModule('audio-worklet.js');
    node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (ev) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(ev.data);
    };
    const src = ctx.createMediaStreamSource(stream);
    const mute = ctx.createGain();
    mute.gain.value = 0;                          // keep the graph pulled without playing the mic back
    src.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
  }

  async function stop() {
    if (state !== 'listening') return;
    setState('stopping');
    setStatus('Finishing…');
    const sock = ws;
    closeMic();
    if (sock && sock.readyState === WebSocket.OPEN) {
      // Ask for the last words, then wait briefly for the final.
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3000);
        stopWaiter = () => { clearTimeout(t); resolve(); };
        sock.send(JSON.stringify({ type: 'flush' }));
      });
      stopWaiter = null;
    }
    await teardown();
    window.Display.endSegment();
    setState('idle');
    setStatus('Stopped. Click or press Space to listen.');
  }

  function closeMic() {
    if (node) { node.port.onmessage = null; node.disconnect(); node = null; }
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
  }
  async function teardown() {
    closeMic();
    const sock = ws;
    ws = null;
    if (sock && sock.readyState <= WebSocket.OPEN) sock.close(1000, 'bye');
  }

  const toggle = () => (state === 'listening' ? stop() : start());
  async function restart() {
    if (state !== 'listening') return;
    await stop();
    await start();
  }

  // ---------------------------------------------------------------- controls
  listenBtn.addEventListener('click', toggle);
  document.getElementById('stage').addEventListener('click', toggle);
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' && e.target === document.body && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      toggle();
    }
  });

  // ---------------------------------------------------------------- microphone picker
  async function refreshMics() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let devices = [];
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    } catch (e) { return; }
    const saved = window.Display.get('mic');
    micSel.textContent = '';
    micSel.add(new Option('Default', ''));
    devices.forEach((d, i) => {
      if (d.deviceId && d.deviceId !== 'default') micSel.add(new Option(d.label || ('Microphone ' + (i + 1)), d.deviceId));
    });
    micSel.value = [...micSel.options].some((o) => o.value === saved) ? saved : '';
  }
  micSel.addEventListener('change', () => {
    window.Display.set('mic', micSel.value);
    restart();
  });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshMics);
  }

  // ---------------------------------------------------------------- model picker
  async function refreshModels() {
    try {
      const list = await (await fetch('/api/models')).json();
      modelSel.textContent = '';
      for (const m of list) {
        const o = new Option(m.name + ' (' + m.size + ')' + (m.installed ? '' : ' - download'), m.name);
        o.dataset.installed = String(m.installed);
        o.dataset.size = m.size;
        modelSel.add(o);
        if (m.active) modelSel.value = m.name;
      }
    } catch (e) { /* server unreachable: the status line already says so */ }
  }
  modelSel.addEventListener('change', async () => {
    const opt = modelSel.selectedOptions[0];
    const name = opt.value;
    const download = opt.dataset.installed !== 'true';
    if (download && !confirm('Download model "' + name + '" (' + opt.dataset.size + ') from huggingface.co?\n\nThis is the only time the app uses the network.')) {
      await refreshModels();
      return;
    }
    setStatus((download ? 'Downloading ' : 'Loading ') + name + '…');
    modelSel.disabled = true;
    try {
      const r = await fetch('/api/models/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, download: download }),
      });
      if (!r.ok) {
        let msg = 'HTTP ' + r.status;
        try { msg = (await r.json()).error || msg; } catch (e) { /* no body */ }
        throw new Error(msg);
      }
      setStatus('Model ' + name + ' ready.');
      await restart();                            // new sessions use the new model
    } catch (err) {
      setStatus('Model change failed: ' + err.message, 'error');
    } finally {
      modelSel.disabled = false;
      await refreshModels();
    }
  });

  // ---------------------------------------------------------------- startup
  (async function init() {
    let intro = FALLBACK_INTRO;
    try {
      const st = await (await fetch('/api/status')).json();
      if (typeof st.introPhrase === 'string') intro = st.introPhrase;
      window.Display.setRetention(st.retentionSeconds);
      window.Display.setAlign(st.align);
      window.Display.setFontRange(st.fontMinPx, st.fontMaxPx);
      if (!st.activeModel) setStatus('No model loaded. See README to download one.', 'error');
    } catch (e) {
      setStatus('Cannot reach the server.', 'error');
    }
    window.Display.intro(intro);
    refreshMics();
    refreshModels();
    if (params.get('autostart') === '1') start();
  })();
})();
