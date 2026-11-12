# Ghost Echo

Local, private, live speech-to-text. An ASP.NET Core server (.NET 10) runs
[whisper.cpp](https://github.com/ggerganov/whisper.cpp) through
[Whisper.net](https://github.com/sandrohanea/whisper.net); a browser page captures the
mic and displays the transcript. Everything runs on your machine.

> **Status:** backend and browser UI (`wwwroot/`) both work. `prototype/` is the standalone look-and-feel experiment the UI grew from.

## Privacy guarantees
- No audio or transcript is ever written to disk, logs, or sent anywhere except back to the
  WebSocket client that produced the audio.
- The server keeps audio only in memory while transcribing, and zeroes the buffers afterwards.
- Logs contain status only (model loaded, session started/ended, errors) - never text or audio.
- The page keeps text only in memory: each line is wiped when it starts to dissolve, and no line outlives
  `RetentionSeconds` after its last update. Nothing is stored in the browser except display settings
  (colors, sizes, motion, selected microphone) in `localStorage` - never text.
- The only outbound network call is a model download that you explicitly request.

See [CLAUDE.md](CLAUDE.md) for the full project rules.

## Requirements
- Windows x64, [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0) (`dotnet --version` -> 10.x)
- ~75 MB - 3 GB disk for models, depending on which you pick

## Run
```powershell
dotnet run
```
Listens on `http://localhost:5080` (localhost only). On first run there is no model yet - see below.

## Using the page
Open <http://localhost:5080>. The intro phrase scrolls in; **click** (or press **Space**) to start/stop
listening and allow the microphone. Words appear at the bottom, scroll up, pixelate past the middle of the
window, and break into dust at the top. New words are revealed at a steady pace (faster when behind) and the scroll speed eases up and down, so long
updates don't make the text lurch. While you speak, the newest words may be rewritten as the model
refines them. Move the mouse to the **right edge** (or press **M**) for settings: microphone, model
(a model that isn't downloaded asks before downloading), colors, text size (8 steps), motion and dust tuning.
Microphone access works on `localhost` or HTTPS only.

Troubleshooting the animation: add `?debug=1` to the URL and open the browser console; it warns if the newest line
moves down (positions only, never text). `window.__trace` then holds per-frame line positions and scroll speed (no text) that you can copy from the console.

## Configuration
Settings live in `appsettings.json` under `Whisper`; override with env vars (`Whisper__Model=small`)
or CLI args (`dotnet run -- --Whisper:Model=small`).

| Setting | Default | Meaning |
|---|---|---|
| `Model` | `base` | Model loaded at startup *if already downloaded*. See `GET /api/models` for choices. |
| `ModelsDir` | `models` | Where `ggml-*.bin` files live (gitignored). |
| `Language` | `en` | Language code, or `auto` (use a non-`.en` model). |
| `Threads` | `4` | CPU threads for whisper.cpp. |
| `RetentionSeconds` | `60` | How long the client keeps transcript text before discarding it. Not adjustable in the page. |
| `StepMs` | `1500` | How often partial (in-progress) text is produced while you speak. |
| `MaxSegmentMs` | `10000` | Force a final transcript when a speech segment reaches this length. |
| `SilenceMs` | `700` | Silence that ends a speech segment (-> final transcript). |
| `SilenceRms` | `0.01` | Loudness (0-1) above which audio counts as speech. Raise in noisy rooms. |

The URL/port is the top-level `Urls` setting.

Display settings under `Ui`:

| Setting | Default | Meaning |
|---|---|---|
| `Align` | `left` | Text alignment, `left` or `center` (`Ui__Align=center`). Not in the page settings menu. |
| `FontMinPx` | `38` | Smallest text size (px). The page's text-size slider has 8 steps from `FontMinPx` to `FontMaxPx`, spaced geometrically. |
| `FontMaxPx` | `156` | Largest text size (px). |
| `IntroPhrase` | (see file) | Phrase scrolled in when the page opens. Empty = no intro. |

### Forbidden-word filter
Words listed in `forbidden-words.txt` (next to the exe / in the project root) are never shown: the server replaces
each one with mask characters before the text is sent, and the page draws them as a pixelated block. The word itself
never reaches the browser. Settings under `Filter`:

| Setting | Default | Meaning |
|---|---|---|
| `Enabled` | `true` | Turn the filter off with `false` (`Filter__Enabled=false`). |
| `WordsFile` | `forbidden-words.txt` | Path to the list; relative paths resolve against the app folder. |

List format: one entry per line; blank lines and `#` comments are ignored. Matching is case-insensitive and
whole-word only (`ass` does not hit `class`). A trailing `*` matches any ending (`fuck*` -> fucking, fucked, ...),
and a line with several words is a phrase. The file is re-read whenever someone starts listening, so edits apply
without a restart. If the file is missing, a warning is logged and nothing is filtered. Whisper may transcribe a word
slightly differently from how you spell it (or sometimes self-censors as `f***`), so list variants you care about.

The page's intro phrase, shown (scrolled in word by word) every time it opens, is `Ui:IntroPhrase`; set it to `""` for no intro:

```json
"Ui": { "IntroPhrase": "Everything said in this room is heard once, ..." }
```

## API
| Endpoint | Purpose |
|---|---|
| `GET /api/status` | Active model, language, retention, intro phrase, alignment, text-size range. `activeModel` is `null` if none loaded. |
| `GET /api/models` | Catalog with `installed` / `active` flags. |
| `POST /api/models/select` | Body `{"name":"base.en","download":false}`. Switches the active model at runtime (new sessions use it; running sessions finish on the old one). `download:true` fetches it from Hugging Face first if missing - without it, a missing model returns `409`. |
| `WS /ws` | Live transcription (below). Returns `503` if no model is loaded. |

### WebSocket protocol
- **Client -> server, binary:** raw little-endian **16-bit PCM, 16 kHz, mono** (any chunk size; ~100 ms is typical).
- **Client -> server, text:** `{"type":"flush"}` - finalize any speech still buffered (send when stopping).
- **Server -> client:**
  - `{"type":"ready","model":"base.en","retentionSeconds":60,"sampleRate":16000}` - once, on connect
  - `{"type":"partial","text":"...","t":7.7}` - in-progress text for the current segment (replaces the previous partial)
  - `{"type":"final","text":"...","t":11}` - segment complete
  - `t` is seconds of audio since the session began - use it (not wall-clock) for retention.

Browsers sending a foreign `Origin` header are rejected (403); curl/scripts (no `Origin`) are fine.

## Testing the backend

You need a terminal for the server and a second for the tests. Commands are PowerShell, run from the repo root.

**1. Build and start**
```powershell
dotnet build            # expect: 0 Warning(s), 0 Error(s)
dotnet run              # leave running; expect "Now listening on: http://localhost:5080"
```
A warning that the default model isn't installed is expected on first run.

**2. Check the API (second terminal)**
```powershell
curl.exe http://localhost:5080/api/status           # activeModel should be null on first run
curl.exe http://localhost:5080/api/models           # list of models, all installed:false
```

**3. Download and activate a model** (75 MB; downloads from huggingface.co - the only network call)
```powershell
curl.exe -X POST -H "Content-Type: application/json" -d '{\"name\":\"tiny.en\",\"download\":true}' http://localhost:5080/api/models/select
# -> {"activeModel":"tiny.en"}   (file appears in models\)
```
Larger models are more accurate but slower. Use `base.en` or `small.en` for real use.

**4. Stream a WAV through the WebSocket**

`samples\jfk.wav` (a public-domain 11 s clip, 16 kHz mono) is included.
```powershell
.\tools\Send-Wav.ps1 -Path .\samples\jfk.wav -Realtime
```
Expected: a `[ready]` line, then yellow `[partial]` lines growing as the clip plays, and green
`[FINAL]` lines, ending with roughly *"Ask not what your country can do for you. Ask what you can do
for your country."* (`tiny.en` may garble the first words - try `base.en`.) Omit `-Realtime` to blast
the audio as fast as possible. To test your own audio, convert it first:
`ffmpeg -i in.mp3 -ar 16000 -ac 1 -c:a pcm_s16le out.wav`.

**5. Error and safety checks**
```powershell
# model switch to a missing model, no download -> 409
curl.exe -X POST -H "Content-Type: application/json" -d '{\"name\":\"small\"}' http://localhost:5080/api/models/select
# unknown/malicious name -> 400
curl.exe -X POST -H "Content-Type: application/json" -d '{\"name\":\"../evil\",\"download\":true}' http://localhost:5080/api/models/select
# foreign browser origin -> 403
curl.exe -i -X POST -H "Origin: http://evil.example" -H "Content-Type: application/json" -d '{\"name\":\"tiny.en\"}' http://localhost:5080/api/models/select
```

**6. Privacy check** - after streaming audio, the server console should show only
`Session started (model ...)` / `Session ended.`, with no transcript text. Nothing new should appear on
disk except model files in `models\`.

**7. Runtime model switch** - download a second model with step 3 (e.g. `base.en`), then run step 4 again:
the `[ready]` line shows the new model, with no server restart.

## Troubleshooting
- **`503` / "No model loaded"** - do step 3.
- **Port in use** - change `Urls` in `appsettings.json` or run with `--urls http://localhost:5090` (and pass `-Url ws://localhost:5090/ws` to the test script).
- **Nothing transcribed from quiet audio** - lower `SilenceRms`; for noisy audio raise it.
- **Slow** - use a smaller or quantized (`-q5_1`) model, or raise `Threads`. GPU runtimes: see [DEPLOY.md](DEPLOY.md).
