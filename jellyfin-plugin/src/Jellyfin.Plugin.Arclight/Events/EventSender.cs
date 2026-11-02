// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Arclight.Arclight;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Arclight.Events;

/// <summary>Outcome of one flush attempt.</summary>
public enum FlushOutcome
{
    /// <summary>Nothing to send.</summary>
    Empty,

    /// <summary>Everything queued at the start was delivered (or deliberately dropped).</summary>
    Sent,

    /// <summary>A transient failure; events were requeued and a backoff started.</summary>
    Retry,

    /// <summary>The plugin is not configured; events were left queued.</summary>
    NotConfigured,
}

/// <summary>
/// Drains the <see cref="EventQueue"/> to Arclight in batches of at most 500, on a timer or when the
/// queue passes its threshold. Transient failures back off exponentially (5 s doubling to 5 min).
/// Runs on its own task; Jellyfin event handlers only ever enqueue.
/// </summary>
public sealed class EventSender : IDisposable
{
    /// <summary>Maximum events per POST (contract limit).</summary>
    public const int MaxBatch = 500;

    private static readonly TimeSpan MinBackoff = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromMinutes(5);

    private readonly EventQueue _queue;
    private readonly ArclightClient _client;
    private readonly IArclightSettings _settings;
    private readonly Func<string> _serverId;
    private readonly ILogger _logger;
    private readonly TimeProvider _time;
    private readonly SemaphoreSlim _signal = new(0, 1);
    private readonly SemaphoreSlim _flushLock = new(1, 1);
    private CancellationTokenSource? _cts;
    private Task? _loop;
    private TimeSpan _backoff = TimeSpan.Zero;
    private DateTimeOffset _retryAt = DateTimeOffset.MinValue;

    /// <summary>Initializes a new instance of the <see cref="EventSender"/> class.</summary>
    /// <param name="queue">Queue.</param>
    /// <param name="client">Arclight client.</param>
    /// <param name="settings">Settings.</param>
    /// <param name="serverId">Jellyfin server id provider.</param>
    /// <param name="logger">Logger.</param>
    /// <param name="time">Clock (tests).</param>
    public EventSender(EventQueue queue, ArclightClient client, IArclightSettings settings, Func<string> serverId, ILogger logger, TimeProvider? time = null)
    {
        _queue = queue;
        _client = client;
        _settings = settings;
        _serverId = serverId;
        _logger = logger;
        _time = time ?? TimeProvider.System;
        _queue.ThresholdReached += (_, _) => Signal();
    }

    /// <summary>Gets the time of the last successful delivery.</summary>
    public DateTimeOffset? LastSuccess { get; private set; }

    /// <summary>Gets the last error message (null after a success).</summary>
    public string? LastError { get; private set; }

    /// <summary>Gets the total number of events delivered.</summary>
    public long Delivered { get; private set; }

    /// <summary>Gets the current backoff (zero when healthy).</summary>
    public TimeSpan Backoff => _backoff;

    /// <summary>Starts the background loop.</summary>
    public void Start()
    {
        if (_loop is not null)
        {
            return;
        }

        _cts = new CancellationTokenSource();
        _loop = Task.Run(() => RunAsync(_cts.Token));
    }

    /// <summary>Stops the loop and makes one short best-effort final flush.</summary>
    /// <returns>A task.</returns>
    public async Task StopAsync()
    {
        if (_cts is null || _loop is null)
        {
            return;
        }

        await _cts.CancelAsync().ConfigureAwait(false);
        try
        {
            await _loop.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }

        using var finalCts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        try
        {
            _retryAt = DateTimeOffset.MinValue;
            await FlushAsync(finalCts.Token).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is OperationCanceledException or HttpRequestException)
        {
            // Shutting down; whatever is left is lost (documented: the queue is in memory).
        }

        _loop = null;
    }

    /// <summary>Requests an early flush.</summary>
    public void Signal()
    {
        try
        {
            if (_signal.CurrentCount == 0)
            {
                _signal.Release();
            }
        }
        catch (SemaphoreFullException)
        {
        }
    }

    /// <summary>Sends everything queued (respecting backoff). Public for tests.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The outcome.</returns>
    public async Task<FlushOutcome> FlushAsync(CancellationToken cancellationToken)
    {
        await _flushLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_queue.Count == 0)
            {
                return FlushOutcome.Empty;
            }

            if (!_client.IsConfigured)
            {
                return FlushOutcome.NotConfigured;
            }

            if (_time.GetUtcNow() < _retryAt)
            {
                return FlushOutcome.Retry;
            }

            var budget = _queue.Count; // do not chase events that arrive while we send
            while (budget > 0)
            {
                var batch = _queue.TakeBatch(Math.Min(MaxBatch, budget));
                if (batch.Count == 0)
                {
                    break;
                }

                budget -= batch.Count;
                var body = new EventBatch { ServerId = _serverId(), Events = batch };
                var response = await _client.SendAsync(HttpMethod.Post, "events", body, null, cancellationToken).ConfigureAwait(false);
                if (response.IsSuccess)
                {
                    Delivered += batch.Count;
                    LastSuccess = _time.GetUtcNow();
                    LastError = null;
                    _backoff = TimeSpan.Zero;
                    _retryAt = DateTimeOffset.MinValue;
                    continue;
                }

                if (IsPermanentFailure(response.StatusCode))
                {
                    // Arclight rejected the data itself; retrying the same batch would loop forever.
                    LastError = $"Arclight rejected {batch.Count} events (HTTP {response.StatusCode}); dropped.";
                    _logger.LogWarning("Arclight rejected an event batch with HTTP {Status}; dropping {Count} events", response.StatusCode, batch.Count);
                    continue;
                }

                _queue.Requeue(batch);
                _backoff = _backoff == TimeSpan.Zero ? MinBackoff : TimeSpan.FromTicks(Math.Min(MaxBackoff.Ticks, _backoff.Ticks * 2));
                _retryAt = _time.GetUtcNow() + _backoff;
                LastError = response.StatusCode == 0
                    ? "Arclight unreachable; retrying in " + (int)_backoff.TotalSeconds + " s."
                    : $"HTTP {response.StatusCode} from Arclight; retrying in {(int)_backoff.TotalSeconds} s.";
                _logger.LogDebug("Event delivery failed ({Status}); backing off {Backoff}", response.StatusCode, _backoff);
                return FlushOutcome.Retry;
            }

            return FlushOutcome.Sent;
        }
        finally
        {
            _flushLock.Release();
        }
    }

    /// <summary>Whether an HTTP status means "do not retry this batch".</summary>
    /// <param name="status">Status code.</param>
    /// <returns>True for 400, 404, 413, 422 (bad data); 401/403/408/429/5xx/0 are retried.</returns>
    public static bool IsPermanentFailure(int status) => status is 400 or 404 or 413 or 422;

    /// <inheritdoc />
    public void Dispose()
    {
        _cts?.Cancel();
        _cts?.Dispose();
        _signal.Dispose();
        _flushLock.Dispose();
    }

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var interval = TimeSpan.FromSeconds(Math.Clamp(_settings.Config.BatchIntervalSeconds, 2, 300));
            var wait = interval;
            var untilRetry = _retryAt - _time.GetUtcNow();
            if (untilRetry > wait)
            {
                wait = untilRetry;
            }

            try
            {
                await _signal.WaitAsync(wait, ct).ConfigureAwait(false);
                await FlushAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // Never let the loop die.
                LastError = ex.Message;
                _logger.LogError(ex, "Unexpected error while sending events to Arclight");
                try
                {
                    await Task.Delay(MinBackoff, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }
    }
}
