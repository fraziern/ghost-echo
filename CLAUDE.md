# Whisper Echo — project rules

Local live speech-to-text: an ASP.NET Core server runs whisper.cpp (via Whisper.net);
a browser page captures the microphone, streams audio over a WebSocket, and displays
the transcription.

## Non-negotiable goals

### 1. Configurable model
- The Whisper model (tiny/base/small/medium/large-v3, `.en` variants, quantized) must be
  selectable: a default in `appsettings.json` (overridable by env var / CLI arg) AND a
  model picker in the UI.
- Models live in a local `models/` folder (gitignored). A missing model is downloaded
  only when the user explicitly selects it.
- Switching models must not require a rebuild or restart; reload the `WhisperFactory`
  at runtime and apply it to new sessions.

### 2. Privacy — ephemeral output only
- Never persist audio or transcribed text: no files, databases, logs, telemetry,
  localStorage/sessionStorage/IndexedDB, cookies, or caches, on server or client.
- Non-content user settings (theme/colors, text size, scroll and dust tuning, selected
  model, selected mic, etc.) MAY be stored in browser storage (localStorage). Never store
  anything derived from audio or transcript content alongside them.
- Transcript display is a rolling window covering the last N seconds of audio
  (`RetentionSeconds`, configurable). Older text is removed from the DOM and from all
  server and client memory — no history, scrollback, or undo.
- Audio buffers are cleared after transcription and when a session ends.
- Transcript text travels only over the WebSocket to the connected client that produced
  the audio — never broadcast, never sent to any other destination.
- Logging may record status (model loaded, connections, errors, timings) but never
  transcript content or audio. Disable ASP.NET request/body logging of WS payloads.
- No "save", "export", or "download transcript" features in production. Any debug aid
  that persists data must be `#if DEBUG`-guarded and off by default.
- Review every change to the audio/text pipeline against these rules.

### 3. Documentation stays current
- `README.md`: purpose, requirements, build/run, configuration (model, retention,
  threads, GPU runtime, bind address/port), privacy guarantees, troubleshooting.
- `DEPLOY.md`: publishing (`dotnet publish`, self-contained win-x64), running as a
  service or on startup if desired, model placement, GPU runtimes, binding to a non-
  localhost address (requires HTTPS for browser mic access), upgrading.
- Update the relevant doc in the same change that alters behavior, config, or setup.

### 4. Web-server backed, local-first
- ASP.NET Core (Kestrel) serves the static UI from `wwwroot/` and the `/ws` endpoint.
- Default bind is `http://localhost` only (browsers allow mic on localhost without
  HTTPS). Exposing on the LAN is opt-in via config and must use HTTPS.
- No cloud APIs, accounts, or outbound network calls except an explicit,
  user-initiated model download. Frontend loads no external CDN assets.

## Tech stack
- .NET 10 (`net10.0`) ASP.NET Core minimal API, `Whisper.net` + `Whisper.net.Runtime`
  (optional `.Cuda` / `.Vulkan`).
- Frontend: plain HTML/CSS/JS in `wwwroot/` (AudioWorklet → 16 kHz mono Int16 frames
  over WebSocket); no frameworks.
- Server sends JSON `{type: "partial"|"final", text, t}`; the client expires lines older
  than `RetentionSeconds`.
