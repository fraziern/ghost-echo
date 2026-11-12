namespace GhostEcho;

/// <summary>Bound from the "Whisper" section of appsettings.json (or env vars / CLI args).</summary>
public sealed class WhisperOptions
{
    /// <summary>Default model name, e.g. "base.en". Must be one of <see cref="ModelCatalog.Names"/>.</summary>
    public string Model { get; set; } = "base.en";

    /// <summary>Folder holding ggml-*.bin files. Relative paths resolve against the content root.</summary>
    public string ModelsDir { get; set; } = "models";

    /// <summary>Language code ("en", "de", ...) or "auto". Use "auto" with multilingual (non .en) models.</summary>
    public string Language { get; set; } = "en";

    public int Threads { get; set; } = 4;

    /// <summary>How many seconds of audio the client keeps text for. Sent to the client; the server keeps nothing.</summary>
    public int RetentionSeconds { get; set; } = 60;

    /// <summary>Interval between partial (in-progress) transcriptions while speech continues.</summary>
    public int StepMs { get; set; } = 1500;

    /// <summary>Force a final transcript when a speech segment reaches this length.</summary>
    public int MaxSegmentMs { get; set; } = 10000;

    /// <summary>Silence needed after speech to finalize a segment.</summary>
    public int SilenceMs { get; set; } = 700;

    /// <summary>RMS level (0..1) above which a frame counts as speech.</summary>
    public float SilenceRms { get; set; } = 0.01f;
}

/// <summary>Bound from the "Filter" section of appsettings.json.</summary>
public sealed class FilterOptions
{
    /// <summary>Master switch for the forbidden-word filter.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Text file of forbidden words, one per line. Relative paths resolve against the content root.</summary>
    public string WordsFile { get; set; } = "forbidden-words.txt";
}

/// <summary>Bound from the "Ui" section of appsettings.json.</summary>
public sealed class UiOptions
{
    /// <summary>Text alignment: "left" (default) or "center". Not exposed in the UI.</summary>
    public string Align { get; set; } = "left";

    /// <summary>Smallest and largest text size (px) of the page's 8-step text-size slider.</summary>
    public int FontMinPx { get; set; } = 38;
    public int FontMaxPx { get; set; } = 156;

    /// <summary>Shown (with the scrolling animation) every time the page opens. Empty = no intro.</summary>
    public string IntroPhrase { get; set; } =
        "Everything said in this room is heard once, written down for a moment, and then let go. Nothing here is saved.";
}
