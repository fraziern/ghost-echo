using Microsoft.Extensions.Options;
using Whisper.net;

namespace WhisperEcho;

/// <summary>Whitelist of selectable models (also guards against path traversal in model names).</summary>
public static class ModelCatalog
{
    public static readonly IReadOnlyDictionary<string, string> Names = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["tiny"] = "~75 MB",
        ["tiny.en"] = "~75 MB",
        ["base"] = "~142 MB",
        ["base.en"] = "~142 MB",
        ["small"] = "~466 MB",
        ["small.en"] = "~466 MB",
        ["medium"] = "~1.5 GB",
        ["medium.en"] = "~1.5 GB",
        ["large-v3"] = "~2.9 GB",
        ["large-v3-turbo"] = "~1.5 GB",
        ["tiny-q5_1"] = "~31 MB",
        ["base-q5_1"] = "~57 MB",
        ["small-q5_1"] = "~181 MB",
        ["medium-q5_0"] = "~514 MB",
        ["large-v3-q5_0"] = "~1.1 GB",
        ["large-v3-turbo-q5_0"] = "~547 MB",
    };

    public static string FileName(string name) => $"ggml-{name}.bin";

    public static string DownloadUrl(string name) =>
        $"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{FileName(name)}";
}

public sealed record ModelInfo(string Name, string Size, bool Installed, bool Active);

/// <summary>
/// Owns the currently loaded <see cref="WhisperFactory"/>. Switching models loads a new factory and
/// retires the old one once the last session using it has finished (new sessions get the new model).
/// </summary>
public sealed class ModelManager : IDisposable
{
    public sealed class Loaded(string name, WhisperFactory factory)
    {
        public string Name { get; } = name;
        public WhisperFactory Factory { get; } = factory;
        public int Leases;
        public bool Retired;
    }

    /// <summary>A reference-counted handle; dispose to release the model.</summary>
    public sealed class Lease(ModelManager owner, Loaded loaded) : IDisposable
    {
        private int _disposed;
        public string ModelName => loaded.Name;
        public WhisperFactory Factory => loaded.Factory;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0) owner.Release(loaded);
        }
    }

    private readonly WhisperOptions _options;
    private readonly string _modelsDir;
    private readonly ILogger<ModelManager> _log;
    private readonly HttpClient _http;
    private readonly object _gate = new();
    private readonly SemaphoreSlim _switchLock = new(1, 1);
    private Loaded? _current;

    public ModelManager(IOptions<WhisperOptions> options, IHostEnvironment env, ILogger<ModelManager> log, HttpClient http)
    {
        _options = options.Value;
        _log = log;
        _http = http;
        _modelsDir = Path.IsPathRooted(_options.ModelsDir)
            ? _options.ModelsDir
            : Path.Combine(env.ContentRootPath, _options.ModelsDir);
        Directory.CreateDirectory(_modelsDir);
    }

    public string? ActiveModel { get { lock (_gate) return _current?.Name; } }

    public string PathFor(string name) => Path.Combine(_modelsDir, ModelCatalog.FileName(name));

    public bool IsInstalled(string name) => File.Exists(PathFor(name));

    public IReadOnlyList<ModelInfo> List()
    {
        var active = ActiveModel;
        return ModelCatalog.Names
            .Select(kv => new ModelInfo(kv.Key, kv.Value, IsInstalled(kv.Key), kv.Key == active))
            .ToList();
    }

    /// <summary>Loads the configured default model at startup if it is already on disk (never downloads).</summary>
    public async Task TryLoadDefaultAsync()
    {
        var name = _options.Model;
        if (!ModelCatalog.Names.ContainsKey(name))
        {
            _log.LogWarning("Configured model '{Model}' is not in the catalog; no model loaded.", name);
            return;
        }
        if (!IsInstalled(name))
        {
            _log.LogWarning("Default model '{Model}' is not installed. Download it with POST /api/models/select " +
                            "{{\"name\":\"{Model}\",\"download\":true}} (see README).", name, name);
            return;
        }
        await SelectAsync(name, download: false, CancellationToken.None);
    }

    /// <summary>Makes <paramref name="name"/> the active model, downloading it first only if <paramref name="download"/> is true.</summary>
    public async Task SelectAsync(string name, bool download, CancellationToken ct)
    {
        if (!ModelCatalog.Names.ContainsKey(name))
            throw new ArgumentException($"Unknown model '{name}'.");

        await _switchLock.WaitAsync(ct);
        try
        {
            if (!IsInstalled(name))
            {
                if (!download)
                    throw new FileNotFoundException($"Model '{name}' is not installed. Retry with download=true to fetch it.");
                await DownloadAsync(name, ct);
            }

            var factory = await Task.Run(() => WhisperFactory.FromPath(PathFor(name)), ct);
            Loaded? old;
            lock (_gate)
            {
                old = _current;
                _current = new Loaded(name, factory);
                if (old is not null) old.Retired = true;
            }
            _log.LogInformation("Model '{Model}' loaded.", name);
            if (old is not null) TryDispose(old);
        }
        finally { _switchLock.Release(); }
    }

    /// <summary>Acquires the active model for the duration of a session; null if none is loaded.</summary>
    public Lease? Acquire()
    {
        lock (_gate)
        {
            if (_current is null) return null;
            _current.Leases++;
            return new Lease(this, _current);
        }
    }

    private void Release(Loaded loaded)
    {
        bool dispose;
        lock (_gate)
        {
            loaded.Leases--;
            dispose = loaded.Retired && loaded.Leases == 0;
        }
        if (dispose) loaded.Factory.Dispose();
    }

    private void TryDispose(Loaded old)
    {
        bool dispose;
        lock (_gate) dispose = old.Leases == 0;
        if (dispose) old.Factory.Dispose();
    }

    private async Task DownloadAsync(string name, CancellationToken ct)
    {
        var finalPath = PathFor(name);
        var tmpPath = finalPath + ".part";
        _log.LogInformation("Downloading model '{Model}' from {Url}", name, ModelCatalog.DownloadUrl(name));
        try
        {
            using var resp = await _http.GetAsync(ModelCatalog.DownloadUrl(name), HttpCompletionOption.ResponseHeadersRead, ct);
            resp.EnsureSuccessStatusCode();
            await using (var src = await resp.Content.ReadAsStreamAsync(ct))
            await using (var dst = File.Create(tmpPath))
                await src.CopyToAsync(dst, ct);
            File.Move(tmpPath, finalPath, overwrite: true);
        }
        catch
        {
            if (File.Exists(tmpPath)) File.Delete(tmpPath);
            throw;
        }
        _log.LogInformation("Model '{Model}' downloaded.", name);
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_current is { Leases: 0 }) _current.Factory.Dispose();
            _current = null;
        }
    }
}
