# Deploying Ghost Echo

Ghost Echo is a local app: deploy it to the machine whose microphone/CPU/GPU you want to use.
The browser UI in `wwwroot/` is static and is included in the publish output automatically.
The page's intro phrase is `Ui:IntroPhrase` (env var `Ui__IntroPhrase`); browsers allow the microphone on
`localhost` or HTTPS only (see "Network exposure" below if you expose it).

## Requirements
- Windows x64
- To build: .NET 10 SDK. To run a published build: nothing, if published self-contained.

## Publish
```powershell
dotnet publish -c Release -r win-x64 --self-contained true -o publish
```
Copy the `publish\` folder anywhere and run `publish\GhostEcho.exe`. It listens on
`http://localhost:5080`, only while it is running (no service is installed).

## Models
- Put `ggml-<name>.bin` files in a `models\` folder next to the exe (or set `Whisper:ModelsDir`
  to an absolute path). Pre-copying models means the app never needs network access.
- Otherwise download from the running app: `POST /api/models/select` with `{"name":"base.en","download":true}`
  (see README). Source: `https://huggingface.co/ggerganov/whisper.cpp`.
- Set the startup model with `Whisper:Model` in `appsettings.json`, the `Whisper__Model` env var, or
  `--Whisper:Model=small` (later overrides earlier). It loads at startup only if its file is already
  in `models\`; otherwise select it in the UI to download it.

### Model names
`Whisper:Model` takes a short name, not a filename: drop the `ggml-` prefix and `.bin` extension
(`small.en` loads `models\ggml-small.en.bin`). Names are case-sensitive and must be one of the
following (the list is `ModelCatalog.Names` in `ModelManager.cs`); custom or renamed files are
not recognized unless added there.

| Group | Names |
|---|---|
| Multilingual | `tiny`, `base`, `small`, `medium`, `large-v3`, `large-v3-turbo` |
| English-only | `tiny.en`, `base.en`, `small.en`, `medium.en` |
| Quantized | `tiny-q5_1`, `base-q5_1`, `small-q5_1`, `medium-q5_0`, `large-v3-q5_0`, `large-v3-turbo-q5_0` |

## Forbidden-word list
`forbidden-words.txt` is copied next to the exe by `dotnet publish`. Edit it in place (picked up when a new
listening session starts, no restart); set `Filter:WordsFile` to use another path, or `Filter:Enabled=false`
to turn the filter off. Format and behavior: see README.

## GPU acceleration (optional)
The default `Whisper.net.Runtime` is CPU-only. For faster transcription, add one runtime package
to `GhostEcho.csproj` and republish; Whisper.net picks the best available at startup:
- NVIDIA: `dotnet add package Whisper.net.Runtime.Cuda` (needs a recent NVIDIA driver and CUDA 12 runtime)
- Any GPU: `dotnet add package Whisper.net.Runtime.Vulkan`

## Configuration
All settings are in `appsettings.json` next to the exe and can be overridden by environment
variables (`Whisper__RetentionSeconds=15`) or CLI arguments. See README for the full table.

## Running at login (optional)
No built-in service. To start on login, create a shortcut to `GhostEcho.exe` in
`shell:startup`. Note it only serves the page on this machine's localhost.

## Network exposure
Default is `http://localhost:5080` - keep it that way unless you must do otherwise. Browsers only
allow microphone access on `localhost` or HTTPS, so serving to other machines requires HTTPS:
1. Provide a certificate (e.g. `dotnet dev-certs https` for testing, a real cert otherwise) and set
   `Urls` to `https://0.0.0.0:5443` with `Kestrel:Certificates:Default` configured.
2. Set `AllowedHosts` in `appsettings.json` to the hostnames you will use (it is `localhost` by default).
3. Remember there is no authentication: anyone who can reach the port can use the transcriber.
   Transcripts still never persist, but restrict access with a firewall.

## Upgrading
Stop the app, replace the `publish\` folder contents (keep your `models\` folder and edited
`appsettings.json`), and start it again.
