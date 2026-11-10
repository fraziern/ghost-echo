<#
.SYNOPSIS
  Test client for the Whisper Echo backend: streams a WAV file to /ws like the browser would
  and prints the partial/final transcript messages it gets back.

.DESCRIPTION
  The WAV must be 16 kHz, mono, 16-bit PCM (the format the browser will send).
  Convert anything else with:  ffmpeg -i in.mp3 -ar 16000 -ac 1 -c:a pcm_s16le out.wav
  Output goes to the console only; nothing is written to disk.

.EXAMPLE
  .\tools\Send-Wav.ps1 -Path .\samples\jfk.wav
  .\tools\Send-Wav.ps1 -Path .\samples\jfk.wav -Realtime
#>
param(
    [Parameter(Mandatory)] [string] $Path,
    [string] $Url = 'ws://localhost:5080/ws',
    [switch] $Realtime,          # pace chunks at real speed (like a live mic) instead of as fast as possible
    [int] $ChunkMs = 100,
    [int] $TailSeconds = 8       # how long to wait for results after the flush
)

$ErrorActionPreference = 'Stop'

# --- parse WAV -------------------------------------------------------------
$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $Path))
if ([Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'RIFF') { throw 'Not a RIFF/WAV file.' }
$pos = 12; $fmt = $null; $dataOff = -1; $dataLen = 0
while ($pos + 8 -le $bytes.Length) {
    $id = [Text.Encoding]::ASCII.GetString($bytes, $pos, 4)
    $len = [BitConverter]::ToInt32($bytes, $pos + 4)
    if ($id -eq 'fmt ') {
        $fmt = @{
            Format = [BitConverter]::ToUInt16($bytes, $pos + 8)
            Channels = [BitConverter]::ToUInt16($bytes, $pos + 10)
            Rate = [BitConverter]::ToInt32($bytes, $pos + 12)
            Bits = [BitConverter]::ToUInt16($bytes, $pos + 22)
        }
    } elseif ($id -eq 'data') {
        $dataOff = $pos + 8
        $dataLen = [Math]::Min($len, $bytes.Length - $dataOff)
        break
    }
    $pos += 8 + $len + ($len % 2)
}
if (-not $fmt -or $dataOff -lt 0) { throw 'Could not find fmt/data chunks.' }
if ($fmt.Format -ne 1 -or $fmt.Channels -ne 1 -or $fmt.Rate -ne 16000 -or $fmt.Bits -ne 16) {
    throw "WAV must be 16 kHz mono 16-bit PCM (got $($fmt.Rate) Hz, $($fmt.Channels) ch, $($fmt.Bits)-bit). Convert with ffmpeg - see script help."
}
$seconds = [Math]::Round($dataLen / 32000.0, 1)
Write-Host "Audio: $seconds s. Connecting to $Url ..."

# --- connect ---------------------------------------------------------------
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
[void]$ws.ConnectAsync([Uri]$Url, [Threading.CancellationToken]::None).GetAwaiter().GetResult()

$buf = New-Object byte[] 65536
$script:recv = $null                       # pending ReceiveAsync task (never cancelled: that would abort the socket)
$script:sb = [Text.StringBuilder]::new()
function Read-Messages([int] $WaitMs) {
    # Print messages as they arrive; return once nothing has arrived for $WaitMs.
    while ($true) {
        if (-not $script:recv) {
            $script:recv = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), [Threading.CancellationToken]::None)
        }
        if (-not $script:recv.Wait($WaitMs)) { return }
        $r = $script:recv.Result
        $script:recv = $null
        if ($r.MessageType -eq 'Close') { return }
        [void]$script:sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $r.Count))
        if (-not $r.EndOfMessage) { continue }
        $m = $script:sb.ToString() | ConvertFrom-Json
        [void]$script:sb.Clear()
        switch ($m.type) {
            'ready'   { Write-Host "[ready]   model=$($m.model) retention=$($m.retentionSeconds)s" -ForegroundColor DarkGray }
            'partial' { Write-Host ("[partial] t={0,6}s  {1}" -f $m.t, $m.text) -ForegroundColor Yellow }
            'final'   { Write-Host ("[FINAL]   t={0,6}s  {1}" -f $m.t, $m.text) -ForegroundColor Green }
            default   { Write-Host "[$($m.type)] $($m | ConvertTo-Json -Compress)" }
        }
    }
}

[void](Read-Messages 1500)   # pick up the 'ready' message

# --- stream ----------------------------------------------------------------
$chunkBytes = 32 * $ChunkMs  # 16000 samples/s * 2 bytes / 1000
for ($off = 0; $off -lt $dataLen; $off += $chunkBytes) {
    $n = [Math]::Min($chunkBytes, $dataLen - $off)
    $seg = [ArraySegment[byte]]::new($bytes, $dataOff + $off, $n)
    [void]$ws.SendAsync($seg, 'Binary', $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    if ($Realtime) { Start-Sleep -Milliseconds $ChunkMs }
}

# --- flush (finalize any trailing speech), then collect results ------------
$flush = [Text.Encoding]::UTF8.GetBytes('{"type":"flush"}')
[void]$ws.SendAsync([ArraySegment[byte]]::new($flush), 'Text', $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
Write-Host "Sent all audio + flush; waiting up to $TailSeconds s for results ..."
[void](Read-Messages ($TailSeconds * 1000))

if ($ws.State -eq 'Open') {
    # The pending receive (if any) completes with the server's close reply.
    [void]$ws.CloseOutputAsync('NormalClosure', 'done', [Threading.CancellationToken]::None).GetAwaiter().GetResult()
}
$ws.Dispose()
Write-Host 'Done.'
