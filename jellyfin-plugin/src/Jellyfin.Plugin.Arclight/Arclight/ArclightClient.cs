// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.Arclight.Arclight;

/// <summary>A raw response from Arclight, passed through to the browser by the proxy.</summary>
/// <param name="StatusCode">HTTP status (0 when Arclight could not be reached).</param>
/// <param name="Body">Response body (JSON or empty).</param>
public sealed record ArclightResponse(int StatusCode, string Body)
{
    /// <summary>Gets a value indicating whether the status is 2xx.</summary>
    public bool IsSuccess => StatusCode is >= 200 and < 300;
}

/// <summary>
/// Talks to the Arclight server's <c>/api/v1/jellyfin/*</c> API. The API key is attached here and
/// only here; nothing in this class ever returns it.
/// </summary>
public sealed class ArclightClient : IDisposable
{
    /// <summary>Header carrying the Arclight API key.</summary>
    public const string ApiKeyHeader = "X-Api-Key";

    /// <summary>Header carrying the Jellyfin user id (32 lowercase hex chars, Guid "N" format).</summary>
    public const string UserHeader = "X-Arclight-Jellyfin-User";

    /// <summary>JSON options matching Arclight (camelCase, nulls omitted).</summary>
    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>Largest JSON body accepted from Arclight.</summary>
    internal const int MaxJsonBytes = 4 * 1024 * 1024;

    /// <summary>Largest static resource (stylesheet, font) accepted from Arclight.</summary>
    internal const int MaxResourceBytes = 8 * 1024 * 1024;

    private readonly HttpClient _http;
    private readonly IArclightSettings _settings;
    private readonly bool _ownsClient;
    private readonly object _featuresLock = new();
    private (string Key, IReadOnlyList<string>? Features, DateTimeOffset At)? _features;

    /// <summary>Initializes a new instance of the <see cref="ArclightClient"/> class.</summary>
    /// <param name="settings">Settings source.</param>
    public ArclightClient(IArclightSettings settings)
        : this(settings, new HttpClient(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5), ConnectTimeout = TimeSpan.FromSeconds(10) }), true)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="ArclightClient"/> class (tests).</summary>
    /// <param name="settings">Settings source.</param>
    /// <param name="http">HTTP client to use.</param>
    /// <param name="ownsClient">Whether to dispose the client.</param>
    public ArclightClient(IArclightSettings settings, HttpClient http, bool ownsClient = false)
    {
        _settings = settings;
        _http = http;
        _http.Timeout = TimeSpan.FromSeconds(20);
        _ownsClient = ownsClient;
    }

    /// <summary>Gets a value indicating whether a URL and key are configured.</summary>
    public bool IsConfigured => TryBuildBase(_settings.ArclightUrl, out _) && _settings.ApiKey.Length > 0;

    /// <summary>Formats a Jellyfin user id the way it is sent to Arclight.</summary>
    /// <param name="userId">User id.</param>
    /// <returns>32 lowercase hex characters.</returns>
    public static string FormatUserId(Guid userId) => userId.ToString("N");

    /// <summary>Validates and normalises a base URL (absolute http/https, no query, no trailing slash).</summary>
    /// <param name="url">Configured URL.</param>
    /// <param name="baseUrl">Normalised URL.</param>
    /// <returns>Whether the URL is usable.</returns>
    public static bool TryBuildBase(string? url, out string baseUrl)
    {
        baseUrl = string.Empty;
        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri))
        {
            return false;
        }

        if ((uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.UserInfo))
        {
            return false;
        }

        baseUrl = uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
        return true;
    }

    /// <summary>Builds the request for a Jellyfin-integration endpoint. Exposed for tests.</summary>
    /// <param name="baseUrl">Normalised base URL.</param>
    /// <param name="apiKey">API key.</param>
    /// <param name="method">HTTP method.</param>
    /// <param name="relativePath">Path below /api/v1/jellyfin/, may include a query string.</param>
    /// <param name="body">Body to serialize as JSON, or null.</param>
    /// <param name="jellyfinUserId">Jellyfin user for per-user calls.</param>
    /// <returns>The request message.</returns>
    public static HttpRequestMessage BuildRequest(string baseUrl, string apiKey, HttpMethod method, string relativePath, object? body, Guid? jellyfinUserId)
    {
        var request = new HttpRequestMessage(method, baseUrl + "/api/v1/jellyfin/" + relativePath.TrimStart('/'));
        request.Headers.TryAddWithoutValidation(ApiKeyHeader, apiKey);
        if (jellyfinUserId is { } uid && uid != Guid.Empty)
        {
            request.Headers.TryAddWithoutValidation(UserHeader, FormatUserId(uid));
        }

        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.UserAgent.Add(new ProductInfoHeaderValue("Arclight-Jellyfin", typeof(ArclightClient).Assembly.GetName().Version?.ToString() ?? "1.0"));
        if (body is not null)
        {
            var json = body as string ?? JsonSerializer.Serialize(body, body.GetType(), JsonOptions);
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        }

        return request;
    }

    /// <summary>Calls an Arclight endpoint with the configured URL and key.</summary>
    /// <param name="method">HTTP method.</param>
    /// <param name="relativePath">Path below /api/v1/jellyfin/.</param>
    /// <param name="body">JSON body or null.</param>
    /// <param name="jellyfinUserId">Jellyfin user for per-user calls.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The response; status 0 when Arclight is unreachable or not configured.</returns>
    public Task<ArclightResponse> SendAsync(HttpMethod method, string relativePath, object? body, Guid? jellyfinUserId, CancellationToken cancellationToken)
        => SendAsync(_settings.ArclightUrl, _settings.ApiKey, method, relativePath, body, jellyfinUserId, cancellationToken);

    /// <summary>Calls an Arclight endpoint with an explicit URL and key (used by "Test connection").</summary>
    /// <param name="url">Base URL.</param>
    /// <param name="apiKey">API key.</param>
    /// <param name="method">HTTP method.</param>
    /// <param name="relativePath">Path below /api/v1/jellyfin/.</param>
    /// <param name="body">JSON body or null.</param>
    /// <param name="jellyfinUserId">Jellyfin user for per-user calls.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The response.</returns>
    public async Task<ArclightResponse> SendAsync(string url, string apiKey, HttpMethod method, string relativePath, object? body, Guid? jellyfinUserId, CancellationToken cancellationToken)
    {
        if (!TryBuildBase(url, out var baseUrl) || string.IsNullOrEmpty(apiKey))
        {
            return new ArclightResponse(0, "{\"code\":\"not_configured\"}");
        }

        using var request = BuildRequest(baseUrl, apiKey, method, relativePath, body, jellyfinUserId);
        try
        {
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            var bytes = await ReadBoundedAsync(response.Content, MaxJsonBytes, cancellationToken).ConfigureAwait(false);
            if (bytes is null)
            {
                return new ArclightResponse(502, "{\"code\":\"response_too_large\"}");
            }

            return new ArclightResponse((int)response.StatusCode, Decode(bytes, response.Content.Headers.ContentType?.CharSet));
        }
        catch (HttpRequestException)
        {
            return new ArclightResponse(0, "{\"code\":\"arclight_unreachable\"}");
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new ArclightResponse(0, "{\"code\":\"arclight_timeout\"}");
        }
    }

    /// <summary>
    /// The features the configured Arclight advertises in <c>GET /ping</c>, so the web UI can hide what
    /// an older Arclight doesn't have. Cached for 10 minutes (1 minute after a failed ping).
    /// </summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Feature names, or null when Arclight could not be asked.</returns>
    public async Task<IReadOnlyList<string>?> GetFeaturesAsync(CancellationToken cancellationToken)
    {
        var key = _settings.ArclightUrl + "\n" + _settings.ApiKey.GetHashCode(StringComparison.Ordinal);
        var now = DateTimeOffset.UtcNow;
        lock (_featuresLock)
        {
            if (_features is { } c && c.Key == key && now - c.At < (c.Features is null ? TimeSpan.FromMinutes(1) : TimeSpan.FromMinutes(10)))
            {
                return c.Features;
            }
        }

        var response = await SendAsync(HttpMethod.Get, "ping", null, null, cancellationToken).ConfigureAwait(false);
        var features = response.IsSuccess ? ParseFeatures(response.Body) : null;
        lock (_featuresLock)
        {
            _features = (key, features, now);
        }

        return features;
    }

    /// <summary>Reads <c>features</c> from a ping body.</summary>
    /// <param name="body">Ping response.</param>
    /// <returns>Feature names (at most 200, each at most 64 characters), or null when the body has none.</returns>
    public static IReadOnlyList<string>? ParseFeatures(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("features", out var list) || list.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            var result = new List<string>();
            foreach (var f in list.EnumerateArray())
            {
                if (f.ValueKind == JsonValueKind.String && f.GetString() is { Length: > 0 and <= 64 } name && result.Count < 200)
                {
                    result.Add(name);
                }
            }

            return result;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Fetches a static resource (theme stylesheet, font) with the configured key.</summary>
    /// <param name="relativePath">Path below /api/v1/jellyfin/.</param>
    /// <param name="ifNoneMatch">ETag to revalidate, or null.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Status (0 = unreachable/unconfigured), body bytes, content type and ETag.</returns>
    public async Task<(int Status, byte[] Body, string? ContentType, string? ETag)> GetBytesAsync(string relativePath, string? ifNoneMatch, CancellationToken cancellationToken)
    {
        if (!TryBuildBase(_settings.ArclightUrl, out var baseUrl) || _settings.ApiKey.Length == 0)
        {
            return (0, Array.Empty<byte>(), null, null);
        }

        using var request = BuildRequest(baseUrl, _settings.ApiKey, HttpMethod.Get, relativePath, null, null);
        request.Headers.Accept.Clear();
        if (!string.IsNullOrEmpty(ifNoneMatch))
        {
            request.Headers.TryAddWithoutValidation("If-None-Match", ifNoneMatch);
        }

        try
        {
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            var bytes = await ReadBoundedAsync(response.Content, MaxResourceBytes, cancellationToken).ConfigureAwait(false);
            if (bytes is null)
            {
                return (502, Array.Empty<byte>(), null, null);
            }

            return ((int)response.StatusCode, bytes, response.Content.Headers.ContentType?.ToString(), response.Headers.ETag?.ToString());
        }
        catch (HttpRequestException)
        {
            return (0, Array.Empty<byte>(), null, null);
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return (0, Array.Empty<byte>(), null, null);
        }
    }

    /// <summary>
    /// Reads a response body, giving up (null) as soon as it would exceed <paramref name="maxBytes"/>:
    /// a declared Content-Length over the limit is refused before reading, and a chunked or lying body
    /// is cut off at the limit, so a huge upstream response can never be buffered whole.
    /// </summary>
    /// <param name="content">Response content.</param>
    /// <param name="maxBytes">Limit.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The body, or null when it is too large.</returns>
    internal static async Task<byte[]?> ReadBoundedAsync(HttpContent content, int maxBytes, CancellationToken cancellationToken)
    {
        if (content.Headers.ContentLength is { } declared && declared > maxBytes)
        {
            return null;
        }

        var stream = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        await using (stream.ConfigureAwait(false))
        {
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            while (true)
            {
                var read = await stream.ReadAsync(chunk.AsMemory(0, (int)Math.Min(chunk.Length, maxBytes + 1L - buffer.Length)), cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    return buffer.ToArray();
                }

                buffer.Write(chunk, 0, read);
                if (buffer.Length > maxBytes)
                {
                    return null;
                }
            }
        }
    }

    private static string Decode(byte[] bytes, string? charset)
    {
        var encoding = Encoding.UTF8;
        if (!string.IsNullOrWhiteSpace(charset))
        {
            try
            {
                encoding = Encoding.GetEncoding(charset.Trim('"', ' '));
            }
            catch (ArgumentException)
            {
                encoding = Encoding.UTF8;
            }
        }

        // Strip a byte-order mark the way ReadAsStringAsync did.
        var preamble = encoding.GetPreamble();
        var offset = preamble.Length > 0 && bytes.AsSpan().StartsWith(preamble) ? preamble.Length : 0;
        return encoding.GetString(bytes, offset, bytes.Length - offset);
    }

    /// <inheritdoc />
    public void Dispose()
    {
        if (_ownsClient)
        {
            _http.Dispose();
        }
    }
}
