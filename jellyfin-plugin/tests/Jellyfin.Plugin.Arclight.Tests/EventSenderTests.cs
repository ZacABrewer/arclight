// SPDX-License-Identifier: GPL-3.0-or-later
using System.Net;
using System.Text.Json;
using Jellyfin.Plugin.Arclight.Arclight;
using Jellyfin.Plugin.Arclight.Events;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.Arclight.Tests;

public class EventSenderTests
{
    private readonly FakeSettings _settings = new();
    private readonly ManualTime _time = new();
    private readonly RecordingHandler _handler = new();
    private readonly EventQueue _queue = new(5000);
    private readonly EventSender _sender;

    public EventSenderTests()
    {
        var client = new ArclightClient(_settings, new HttpClient(_handler));
        _sender = new EventSender(_queue, client, _settings, () => "server-123", NullLogger.Instance, _time);
    }

    private void Fill(int n)
    {
        for (var i = 0; i < n; i++)
        {
            _queue.Enqueue(new ArclightEvent { Type = EventTypes.ItemAdded, At = i.ToString() });
        }
    }

    [Fact]
    public async Task Sends_batches_of_at_most_500_with_api_key_and_server_id()
    {
        Fill(1200);
        Assert.Equal(FlushOutcome.Sent, await _sender.FlushAsync(CancellationToken.None));

        Assert.Equal(3, _handler.Requests.Count);
        var sizes = new List<int>();
        foreach (var (request, body) in _handler.Requests)
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Equal("http://arclight.test:7000/api/v1/jellyfin/events", request.RequestUri!.ToString());
            Assert.Equal("secret-key-1234", request.Headers.GetValues(ArclightClient.ApiKeyHeader).Single());
            Assert.False(request.Headers.Contains(ArclightClient.UserHeader)); // server-level call
            using var doc = JsonDocument.Parse(body);
            Assert.Equal("server-123", doc.RootElement.GetProperty("serverId").GetString());
            sizes.Add(doc.RootElement.GetProperty("events").GetArrayLength());
        }

        Assert.Equal(new[] { 500, 500, 200 }, sizes);
        Assert.Equal(0, _queue.Count);
        Assert.Equal(1200, _sender.Delivered);
    }

    [Fact]
    public async Task Transient_failure_requeues_and_backs_off_exponentially()
    {
        Fill(10);
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.ServiceUnavailable, "{}");

        Assert.Equal(FlushOutcome.Retry, await _sender.FlushAsync(CancellationToken.None));
        Assert.Equal(10, _queue.Count);
        Assert.Equal(TimeSpan.FromSeconds(5), _sender.Backoff);

        // Within the backoff window nothing is attempted.
        Assert.Equal(FlushOutcome.Retry, await _sender.FlushAsync(CancellationToken.None));
        Assert.Single(_handler.Requests);

        _time.Advance(TimeSpan.FromSeconds(6));
        Assert.Equal(FlushOutcome.Retry, await _sender.FlushAsync(CancellationToken.None));
        Assert.Equal(TimeSpan.FromSeconds(10), _sender.Backoff);

        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.Accepted, "{}");
        _time.Advance(TimeSpan.FromSeconds(11));
        Assert.Equal(FlushOutcome.Sent, await _sender.FlushAsync(CancellationToken.None));
        Assert.Equal(TimeSpan.Zero, _sender.Backoff);
        Assert.Equal(0, _queue.Count);
        Assert.Null(_sender.LastError);
    }

    [Fact]
    public async Task Backoff_is_capped_at_five_minutes()
    {
        Fill(1);
        _handler.Respond = (_, _) => throw new HttpRequestException("down");
        for (var i = 0; i < 12; i++)
        {
            await _sender.FlushAsync(CancellationToken.None);
            _time.Advance(TimeSpan.FromMinutes(6));
        }

        Assert.Equal(TimeSpan.FromMinutes(5), _sender.Backoff);
        Assert.Equal(1, _queue.Count);
    }

    [Fact]
    public async Task Rejected_batches_are_dropped_not_retried()
    {
        Fill(3);
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.BadRequest, "{\"code\":\"invalid\"}");
        Assert.Equal(FlushOutcome.Sent, await _sender.FlushAsync(CancellationToken.None));
        Assert.Equal(0, _queue.Count);
        Assert.Contains("400", _sender.LastError);
    }

    [Fact]
    public async Task Unauthorized_is_retried_because_the_admin_can_fix_the_key()
    {
        Fill(3);
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.Unauthorized, "{}");
        Assert.Equal(FlushOutcome.Retry, await _sender.FlushAsync(CancellationToken.None));
        Assert.Equal(3, _queue.Count);
    }

    [Fact]
    public async Task Not_configured_keeps_events()
    {
        Fill(2);
        _settings.ArclightUrl = "not a url";
        Assert.Equal(FlushOutcome.NotConfigured, await _sender.FlushAsync(CancellationToken.None));
        Assert.Empty(_handler.Requests);
        Assert.Equal(2, _queue.Count);
    }

    [Fact]
    public async Task Background_loop_flushes_when_threshold_is_reached()
    {
        _settings.Config.BatchIntervalSeconds = 300; // the timer alone would take 5 minutes
        var sender = new EventSender(_queue, new ArclightClient(_settings, new HttpClient(_handler)), _settings, () => "s", NullLogger.Instance);
        sender.Start();
        try
        {
            Fill(_queue.FlushThreshold);
            var deadline = DateTime.UtcNow.AddSeconds(10);
            while (_handler.Requests.Count == 0 && DateTime.UtcNow < deadline)
            {
                await Task.Delay(20);
            }

            Assert.NotEmpty(_handler.Requests);
        }
        finally
        {
            await sender.StopAsync();
        }
    }
}
