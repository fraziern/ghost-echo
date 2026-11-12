using System.Buffers;
using System.Net;
using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.Extensions.Options;
using GhostEcho;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<WhisperOptions>(builder.Configuration.GetSection("Whisper"));
builder.Services.Configure<UiOptions>(builder.Configuration.GetSection("Ui"));
builder.Services.Configure<FilterOptions>(builder.Configuration.GetSection("Filter"));
builder.Services.AddSingleton(sp => new ProfanityFilter(
    sp.GetRequiredService<IOptions<FilterOptions>>().Value,
    sp.GetRequiredService<IHostEnvironment>(),
    sp.GetRequiredService<ILogger<ProfanityFilter>>()));
builder.Services.AddSingleton(sp => new ModelManager(
    sp.GetRequiredService<IOptions<WhisperOptions>>(),
    sp.GetRequiredService<IHostEnvironment>(),
    sp.GetRequiredService<ILogger<ModelManager>>(),
    new HttpClient { Timeout = Timeout.InfiniteTimeSpan }));

var app = builder.Build();

var opt = app.Services.GetRequiredService<IOptions<WhisperOptions>>().Value;
var ui = app.Services.GetRequiredService<IOptions<UiOptions>>().Value;
var models = app.Services.GetRequiredService<ModelManager>();
var filter = app.Services.GetRequiredService<ProfanityFilter>();
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);

try { await models.TryLoadDefaultAsync(); }
catch (Exception ex) { app.Logger.LogError(ex, "Failed to load default model."); }

app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20) });
app.UseDefaultFiles();
// "no-cache" lets browsers keep a copy but forces revalidation (ETag / Last-Modified) on every load, so a rebuilt
// or republished app.js / style.css / etc. is picked up immediately, and unchanged files cost only a 304.
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx => ctx.Context.Response.Headers.CacheControl = "no-cache",
});

// Browsers send an Origin header on cross-site requests; refuse any that isn't this server itself,
// so a random web page can't drive the local API. Non-browser tools (curl, scripts) send no Origin.
static bool OriginAllowed(HttpContext ctx)
{
    if (!ctx.Request.Headers.TryGetValue("Origin", out var origin) || origin.Count == 0) return true;
    return Uri.TryCreate(origin[0], UriKind.Absolute, out var u)
           && string.Equals(u.Authority, ctx.Request.Host.Value, StringComparison.OrdinalIgnoreCase);
}

app.MapGet("/api/status", () => new
{
    activeModel = models.ActiveModel,
    language = opt.Language,
    retentionSeconds = opt.RetentionSeconds,
    introPhrase = ui.IntroPhrase,
    align = ui.Align,
    fontMinPx = ui.FontMinPx,
    fontMaxPx = ui.FontMaxPx,
});

app.MapGet("/api/models", () => models.List());

app.MapPost("/api/models/select", async (HttpContext ctx, SelectModelRequest req, CancellationToken ct) =>
{
    if (!OriginAllowed(ctx)) return Results.StatusCode(StatusCodes.Status403Forbidden);
    try
    {
        await models.SelectAsync(req.Name, req.Download, ct);
        return Results.Ok(new { activeModel = models.ActiveModel });
    }
    catch (ArgumentException ex) { return Results.BadRequest(new { error = ex.Message }); }
    catch (FileNotFoundException ex) { return Results.Conflict(new { error = ex.Message }); }
    catch (HttpRequestException ex) { return Results.Json(new { error = $"Download failed: {ex.Message}" }, statusCode: 502); }
});

app.Map("/ws", async (HttpContext ctx) =>
{
    if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }
    if (!OriginAllowed(ctx)) { ctx.Response.StatusCode = 403; return; }

    using var lease = models.Acquire();
    if (lease is null)
    {
        ctx.Response.StatusCode = 503;
        await ctx.Response.WriteAsync("No model loaded. See README: select/download a model first.");
        return;
    }

    using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
    var sendLock = new SemaphoreSlim(1, 1);

    async ValueTask Send(object message)
    {
        if (ws.State != WebSocketState.Open) return;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message, json);
        await sendLock.WaitAsync();
        try { await ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None); }
        catch (Exception) { /* client went away */ }
        finally { sendLock.Release(); }
    }

    filter.Reload(); // pick up edits to the word list
    await using var session = new StreamingSession(lease.Factory, opt, ev => Send(ev), filter);
    app.Logger.LogInformation("Session started (model {Model}).", lease.ModelName);
    await Send(new { type = "ready", model = lease.ModelName, retentionSeconds = opt.RetentionSeconds, sampleRate = StreamingSession.SampleRate });

    const int MaxMessageBytes = 1 << 20;
    var chunk = new byte[16 * 1024];
    var message = new ArrayBufferWriter<byte>(8192);

    try
    {
        while (ws.State == WebSocketState.Open)
        {
            message.Clear();
            ValueWebSocketReceiveResult r;
            do
            {
                r = await ws.ReceiveAsync(chunk.AsMemory(), ctx.RequestAborted);
                if (r.MessageType == WebSocketMessageType.Close) goto done;
                if (message.WrittenCount + r.Count > MaxMessageBytes)
                {
                    await ws.CloseAsync(WebSocketCloseStatus.MessageTooBig, "message too large", CancellationToken.None);
                    goto done;
                }
                message.Write(chunk.AsSpan(0, r.Count));
            } while (!r.EndOfMessage);

            if (r.MessageType == WebSocketMessageType.Binary)
            {
                session.AddAudio(message.WrittenSpan);
            }
            else if (IsFlush(message.WrittenSpan))
            {
                session.Flush();
            }

            // ArrayBufferWriter.Clear() zeroes the written bytes: wipe received audio before the next read
            message.Clear();
        }
    }
    catch (OperationCanceledException) { }
    catch (WebSocketException) { }

done:
    Array.Clear(chunk);
    message.Clear();
    // Disposing waits for queued transcriptions (e.g. the final from a flush) before we close the socket.
    await session.DisposeAsync();
    if (ws.State is WebSocketState.Open or WebSocketState.CloseReceived)
    {
        try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None); }
        catch (Exception) { }
    }
    app.Logger.LogInformation("Session ended.");

    static bool IsFlush(ReadOnlySpan<byte> utf8)
    {
        try
        {
            using var doc = JsonDocument.Parse(utf8.ToArray());
            return doc.RootElement.TryGetProperty("type", out var t) && t.GetString() == "flush";
        }
        catch (JsonException) { return false; }
    }
});

app.Run();

internal sealed record SelectModelRequest(string Name, bool Download = false);
