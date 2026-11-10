using System.Text;
using System.Text.RegularExpressions;

namespace GhostEcho;

/// <summary>
/// Replaces forbidden words in transcript text with <see cref="MaskChar"/> (one per letter). The browser draws every
/// run of mask characters as a pixelated block, so the forbidden word itself never leaves the server.
/// The word list is a plain text file (one entry per line, "#" comments, "*" suffix = any ending). It is re-read
/// whenever a new session starts, so edits apply without a restart.
/// PRIVACY: only the word list is ever read; transcript text is processed in memory and never logged or stored.
/// </summary>
public sealed class ProfanityFilter
{
    /// <summary>Private-use code point standing in for one masked letter. Must match MASK in wwwroot/app.js.</summary>
    public const char MaskChar = '';

    private readonly string? _path;
    private readonly ILogger _log;
    private readonly object _gate = new();
    private DateTime _stamp = DateTime.MinValue;
    private Regex? _regex;

    public ProfanityFilter(FilterOptions options, IHostEnvironment env, ILogger<ProfanityFilter> log)
    {
        _log = log;
        if (!options.Enabled || string.IsNullOrWhiteSpace(options.WordsFile)) return;
        _path = Path.IsPathRooted(options.WordsFile) ? options.WordsFile : Path.Combine(env.ContentRootPath, options.WordsFile);
        Reload();
    }

    /// <summary>Re-reads the word list if the file changed since the last load.</summary>
    public void Reload()
    {
        if (_path is null) return;
        lock (_gate)
        {
            try
            {
                if (!File.Exists(_path))
                {
                    if (_stamp != DateTime.MaxValue) _log.LogWarning("Word filter list not found; no words are filtered.");
                    _stamp = DateTime.MaxValue; // warn once
                    _regex = null;
                    return;
                }
                var stamp = File.GetLastWriteTimeUtc(_path);
                if (stamp == _stamp) return;
                _stamp = stamp;
                _regex = Build(File.ReadAllLines(_path), out int count);
                _log.LogInformation("Word filter loaded ({Count} entries).", count);
            }
            catch (IOException ex) { _log.LogWarning("Word filter list could not be read: {Error}", ex.Message); }
        }
    }

    private static Regex? Build(IEnumerable<string> lines, out int count)
    {
        var alts = new List<string>();
        foreach (var raw in lines)
        {
            var line = raw.Trim();
            if (line.Length == 0 || line[0] == '#') continue;
            bool prefix = line.EndsWith('*');
            if (prefix) line = line.TrimEnd('*').TrimEnd();
            if (line.Length == 0) continue;
            var parts = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Select(Regex.Escape);
            alts.Add(string.Join(@"\s+", parts) + (prefix ? @"\p{L}*" : ""));
        }
        count = alts.Count;
        if (alts.Count == 0) return null;
        // Longest first so "motherfucker" wins over "mother" etc.; whole words only (letters/digits on neither side).
        alts.Sort((a, b) => b.Length.CompareTo(a.Length));
        return new Regex(@"(?<![\p{L}\p{N}])(?:" + string.Join("|", alts) + @")(?![\p{L}\p{N}])",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    }

    public string Apply(string text)
    {
        var rx = _regex;
        if (rx is null || text.Length == 0) return text;
        try { return rx.Replace(text, m => Mask(m.Value)); }
        catch (RegexMatchTimeoutException) { return text; }
    }

    private static string Mask(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (var c in s) sb.Append(char.IsWhiteSpace(c) ? c : MaskChar);
        return sb.ToString();
    }
}
