// SPDX-License-Identifier: GPL-3.0-or-later
using System.Net;
using System.Text;
using Jellyfin.Plugin.Arclight.Arclight;
using Jellyfin.Plugin.Arclight.Configuration;
using Jellyfin.Plugin.Arclight.Events;

namespace Jellyfin.Plugin.Arclight.Tests;

internal sealed class FakeSettings : IArclightSettings
{
    public string ArclightUrl { get; set; } = "http://arclight.test:7000";

    public string ApiKey { get; set; } = "secret-key-1234";

    public PluginConfiguration Config { get; set; } = new();
}

internal sealed class ManualTime : TimeProvider
{
    public DateTimeOffset Now { get; set; } = new(2026, 11, 1, 12, 0, 0, TimeSpan.Zero);

    public override DateTimeOffset GetUtcNow() => Now;

    public void Advance(TimeSpan by) => Now += by;
}

/// <summary>Records requests and answers with a scripted status.</summary>
internal sealed class RecordingHandler : HttpMessageHandler
{
    public List<(HttpRequestMessage Request, string Body)> Requests { get; } = new();

    public Func<HttpRequestMessage, string, HttpResponseMessage> Respond { get; set; } =
        (_, _) => new HttpResponseMessage(HttpStatusCode.Accepted) { Content = new StringContent("{}", Encoding.UTF8, "application/json") };

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken);
        Requests.Add((request, body));
        return Respond(request, body);
    }

    public static HttpResponseMessage Json(HttpStatusCode code, string json) => new(code) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
}

internal static class Samples
{
    public static EventItem Movie(string tmdb = "550") => new()
    {
        Id = "0123456789abcdef0123456789abcdef",
        Type = "Movie",
        Name = "Fight Club",
        ProviderIds = new Dictionary<string, string> { ["Tmdb"] = tmdb, ["Imdb"] = "tt0137523" },
        RunTimeTicks = 83_940_000_000,
    };

    public static EventItem Episode(bool withSeriesIds = true) => new()
    {
        Id = "fedcba9876543210fedcba9876543210",
        Type = "Episode",
        Name = "Pilot",
        ProviderIds = new Dictionary<string, string> { ["Tvdb"] = "349232" },
        SeriesProviderIds = withSeriesIds ? new Dictionary<string, string> { ["Tvdb"] = "81189", ["Tmdb"] = "1396" } : new Dictionary<string, string>(),
        SeasonNumber = 1,
        EpisodeNumber = 1,
    };

    public static ArclightEvent Event(string type) => new() { Type = type, At = "2026-11-01T12:00:00.000Z" };
}
