using System.Text.RegularExpressions;
using System.Threading.Channels;
using Whisper.net;

namespace GhostEcho;

public sealed record TranscriptEvent(string Type, string Text, double T);

/// <summary>
/// One session per WebSocket connection. Consumes 16 kHz mono Int16 PCM, detects speech/silence,
/// and emits "partial" (in-progress) and "final" transcripts via <paramref name="emit"/>.
/// PRIVACY: audio and text live only in memory here; every buffer is zeroed after use and nothing is logged.
/// </summary>
public sealed partial class StreamingSession : IAsyncDisposable
{
    public const int SampleRate = 16000;
    private const int PrerollMs = 300;
    private const int OverlapMs = 200;
    private const int MinSpeechMs = 400;

    private readonly WhisperProcessor _processor;
    private readonly WhisperOptions _opt;
    private readonly Func<TranscriptEvent, ValueTask> _emit;
    private readonly Channel<Job> _jobs = Channel.CreateUnbounded<Job>(new() { SingleReader = true });
    private readonly Task _worker;
    private readonly CancellationTokenSource _cts = new();

    private float[] _buf = new float[SampleRate * 12];
    private int _count;
    private bool _speechSeen;
    private int _silenceSamples;
    private int _samplesSincePartial;
    private long _totalSamples; // audio time since session start
    private int _queued;        // jobs enqueued but not finished
    private int _finalsPending;
    private int _disposed;

    private sealed record Job(bool Final, float[] Samples, double EndSeconds);

    private readonly ProfanityFilter? _filter;

    public StreamingSession(WhisperFactory factory, WhisperOptions opt, Func<TranscriptEvent, ValueTask> emit, ProfanityFilter? filter = null)
    {
        _filter = filter;
        _opt = opt;
        _emit = emit;
        var builder = factory.CreateBuilder().WithLanguage(opt.Language).WithThreads(opt.Threads);
        _processor = builder.Build();
        _worker = Task.Run(WorkAsync);
    }

    /// <summary>Feed a chunk of little-endian Int16 PCM (16 kHz, mono).</summary>
    public void AddAudio(ReadOnlySpan<byte> pcm16)
    {
        int n = pcm16.Length / 2;
        if (n == 0) return;
        EnsureCapacity(_count + n);

        double sumSq = 0;
        for (int i = 0; i < n; i++)
        {
            float s = (short)(pcm16[2 * i] | (pcm16[2 * i + 1] << 8)) / 32768f;
            _buf[_count + i] = s;
            sumSq += s * s;
        }
        _count += n;
        _totalSamples += n;

        bool loud = Math.Sqrt(sumSq / n) >= _opt.SilenceRms;
        if (loud) { _speechSeen = true; _silenceSamples = 0; }
        else _silenceSamples += n;
        if (_speechSeen) _samplesSincePartial += n;

        if (!_speechSeen)
        {
            // Idle: keep only a short pre-roll so memory stays bounded and silence is never transcribed.
            int keep = Ms(PrerollMs);
            if (_count > keep) Shift(_count - keep);
            return;
        }

        if (_count >= Ms(_opt.MaxSegmentMs))
            Finalize(keepOverlap: true);
        else if (_silenceSamples >= Ms(_opt.SilenceMs))
            Finalize(keepOverlap: false);
        else if (_samplesSincePartial >= Ms(_opt.StepMs))
            EnqueuePartial();
    }

    /// <summary>Client signalled end of audio: finalize whatever speech is buffered.</summary>
    public void Flush()
    {
        if (_speechSeen) Finalize(keepOverlap: false);
        else ClearBuffer();
    }

    private void EnqueuePartial()
    {
        _samplesSincePartial = 0;
        // Skip if the worker is still busy or a final is on its way; the next step will catch up.
        if (Volatile.Read(ref _queued) > 0 || Volatile.Read(ref _finalsPending) > 0) return;
        Enqueue(new Job(false, _buf.AsSpan(0, _count).ToArray(), Seconds(_totalSamples)));
    }

    private void Finalize(bool keepOverlap)
    {
        int speechSamples = _count - Math.Min(_silenceSamples, _count);
        bool enough = speechSamples >= Ms(MinSpeechMs);
        if (enough)
        {
            Interlocked.Increment(ref _finalsPending);
            Enqueue(new Job(true, _buf.AsSpan(0, _count).ToArray(), Seconds(_totalSamples)));
        }

        if (keepOverlap && enough)
        {
            int keep = Math.Min(Ms(OverlapMs), _count);
            Shift(_count - keep);
            _speechSeen = true; // still mid-speech
            _silenceSamples = 0;
            _samplesSincePartial = 0;
        }
        else ClearBuffer();
    }

    private void Enqueue(Job job)
    {
        Interlocked.Increment(ref _queued);
        _jobs.Writer.TryWrite(job);
    }

    private async Task WorkAsync()
    {
        await foreach (var job in _jobs.Reader.ReadAllAsync())
        {
            try
            {
                if (_cts.IsCancellationRequested) continue;
                var text = await TranscribeAsync(job.Samples);
                if (!string.IsNullOrWhiteSpace(text) && !_cts.IsCancellationRequested)
                    await _emit(new TranscriptEvent(job.Final ? "final" : "partial", _filter?.Apply(text) ?? text,Math.Round(job.EndSeconds, 2)));
            }
            catch (OperationCanceledException) { }
            catch (Exception) { /* never log transcript data; surface nothing that could contain it */ }
            finally
            {
                Array.Clear(job.Samples); // wipe the audio snapshot
                Interlocked.Decrement(ref _queued);
                if (job.Final) Interlocked.Decrement(ref _finalsPending);
            }
        }
    }

    private async Task<string> TranscribeAsync(float[] samples)
    {
        var sb = new System.Text.StringBuilder();
        await foreach (var seg in _processor.ProcessAsync(samples, _cts.Token))
            sb.Append(seg.Text);
        var text = sb.ToString().Trim();
        // Drop non-speech markers such as [BLANK_AUDIO], (music), *noise*.
        return NonSpeech().IsMatch(text) ? "" : text;
    }

    [GeneratedRegex(@"^\s*(?:[\[\(\*].*[\]\)\*]\s*)+$")]
    private static partial Regex NonSpeech();

    private int Ms(int ms) => ms * SampleRate / 1000;
    private static double Seconds(long samples) => (double)samples / SampleRate;

    private void EnsureCapacity(int needed)
    {
        if (needed <= _buf.Length) return;
        var bigger = new float[Math.Max(needed, _buf.Length * 2)];
        Array.Copy(_buf, bigger, _count);
        Array.Clear(_buf);
        _buf = bigger;
    }

    /// <summary>Drops the first <paramref name="drop"/> samples, zeroing the vacated tail.</summary>
    private void Shift(int drop)
    {
        Array.Copy(_buf, drop, _buf, 0, _count - drop);
        Array.Clear(_buf, _count - drop, drop);
        _count -= drop;
    }

    private void ClearBuffer()
    {
        Array.Clear(_buf, 0, _count);
        _count = 0;
        _speechSeen = false;
        _silenceSamples = 0;
        _samplesSincePartial = 0;
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1) return;
        _jobs.Writer.TryComplete();
        await _worker;          // let queued finals (e.g. from Flush) finish first
        _cts.Cancel();
        ClearBuffer();
        Array.Clear(_buf);
        await _processor.DisposeAsync();
        _cts.Dispose();
    }
}
