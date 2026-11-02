// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Arclight.Arclight;
using Jellyfin.Plugin.Arclight.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Logging;
using JellyfinUser = Jellyfin.Database.Implementations.Entities.User;

namespace Jellyfin.Plugin.Arclight.Intro;

/// <summary>When the Arclight intro plays (pure rules; unit tested).</summary>
public sealed class IntroPolicy
{
    /// <summary>A "session" for the first-episode-only rule: no intro for this user in this window.</summary>
    public static readonly TimeSpan SessionWindow = TimeSpan.FromHours(3);

    private readonly ConcurrentDictionary<Guid, DateTimeOffset> _lastIntro = new();

    /// <summary>Decides whether to add the intro, and records it when so.</summary>
    /// <param name="config">Settings.</param>
    /// <param name="kind">"movie", "episode" or anything else.</param>
    /// <param name="userId">Jellyfin user.</param>
    /// <param name="now">Current time.</param>
    /// <returns>True to add the intro.</returns>
    public bool ShouldPlay(PluginConfiguration config, string kind, Guid userId, DateTimeOffset now)
    {
        if (!config.EnableIntro || userId == Guid.Empty)
        {
            return false;
        }

        var key = userId.ToString("N");
        if (config.IntroSkipUsers.Any(u => string.Equals(u?.Replace("-", string.Empty, StringComparison.Ordinal), key, StringComparison.OrdinalIgnoreCase)))
        {
            return false;
        }

        switch (kind)
        {
            case "movie" when config.IntroBeforeMovies:
                break;
            case "episode" when config.IntroBeforeEpisodes:
                if (config.IntroFirstEpisodeOnly && _lastIntro.TryGetValue(userId, out var last) && now - last < SessionWindow)
                {
                    return false;
                }

                break;
            default:
                return false;
        }

        _lastIntro[userId] = now;
        if (_lastIntro.Count > 10000)
        {
            foreach (var stale in _lastIntro.Where(p => now - p.Value > SessionWindow).Select(p => p.Key).ToList())
            {
                _lastIntro.TryRemove(stale, out _);
            }
        }

        return true;
    }
}

/// <summary>Extracts the bundled intro videos to a stable folder Jellyfin can play from.</summary>
public sealed class IntroAssets
{
    /// <summary>Quality values.</summary>
    public static readonly IReadOnlyList<string> Qualities = new[] { "1080p", "720p" };

    private readonly string _folder;
    private readonly ILogger<IntroAssets> _logger;
    private readonly object _lock = new();
    private bool _extracted;

    /// <summary>Initializes a new instance of the <see cref="IntroAssets"/> class.</summary>
    /// <param name="paths">Application paths.</param>
    /// <param name="logger">Logger.</param>
    public IntroAssets(IApplicationPaths paths, ILogger<IntroAssets> logger)
        : this(Path.Combine(paths.DataPath, "arclight", "intro"), logger)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="IntroAssets"/> class (tests).</summary>
    /// <param name="folder">Target folder.</param>
    /// <param name="logger">Logger.</param>
    public IntroAssets(string folder, ILogger<IntroAssets> logger)
    {
        _folder = folder;
        _logger = logger;
    }

    /// <summary>Gets the folder the intro files live in (outside every library).</summary>
    public string Folder => _folder;

    /// <summary>Whether a path is one of the Arclight intro files (used to keep it out of events).</summary>
    /// <param name="path">Item path.</param>
    /// <returns>True for the intro.</returns>
    public bool IsIntro(string? path)
        => !string.IsNullOrEmpty(path) && path.StartsWith(_folder, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    /// <summary>The intro file for a quality, extracting the bundled copies on first use or after a plugin update.</summary>
    /// <param name="quality">1080p or 720p.</param>
    /// <returns>Full path, or null when it could not be written.</returns>
    public string? PathFor(string? quality)
    {
        var q = Qualities.Contains(quality ?? string.Empty, StringComparer.OrdinalIgnoreCase) ? quality!.ToLowerInvariant() : "1080p";
        lock (_lock)
        {
            if (!_extracted)
            {
                _extracted = Extract();
            }
        }

        var file = Path.Combine(_folder, "arclight-intro-" + q + ".mp4");
        return File.Exists(file) ? file : null;
    }

    private bool Extract()
    {
        try
        {
            Directory.CreateDirectory(_folder);
            var version = typeof(IntroAssets).Assembly.GetName().Version?.ToString() ?? "0";
            var marker = Path.Combine(_folder, ".version");
            var current = File.Exists(marker) ? File.ReadAllText(marker).Trim() : string.Empty;
            foreach (var q in Qualities)
            {
                var target = Path.Combine(_folder, "arclight-intro-" + q + ".mp4");
                if (current == version && File.Exists(target))
                {
                    continue;
                }

                using var source = typeof(IntroAssets).Assembly.GetManifestResourceStream("Jellyfin.Plugin.Arclight.Intro.arclight-intro-" + q + ".mp4");
                if (source is null)
                {
                    _logger.LogWarning("Arclight: intro resource {Quality} missing from the plugin", q);
                    continue;
                }

                var tmp = target + ".tmp";
                using (var output = File.Create(tmp))
                {
                    source.CopyTo(output);
                }

                File.Move(tmp, target, true);
            }

            File.WriteAllText(marker, version);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Arclight: could not write the intro to {Folder}", _folder);
            return false;
        }
    }
}

/// <summary>
/// Cinema Mode intro: adds the Arclight intro in front of movies (and optionally the first episode of
/// a viewing session). Jellyfin asks every <see cref="IIntroProvider"/> and plays all returned intros,
/// so this adds one item and never replaces trailers or other providers' intros.
/// </summary>
public sealed class ArclightIntroProvider : IIntroProvider
{
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static readonly ConcurrentDictionary<string, Guid> Registered = new(StringComparer.Ordinal);

    private readonly IntroAssets _assets;
    private readonly IntroPolicy _policy;
    private readonly IArclightSettings _settings;
    private readonly ILibraryManager _library;
    private readonly IFileSystem _fileSystem;
    private readonly ILogger<ArclightIntroProvider> _logger;

    /// <summary>Initializes a new instance of the <see cref="ArclightIntroProvider"/> class.</summary>
    /// <param name="assets">Intro files.</param>
    /// <param name="policy">Rules.</param>
    /// <param name="settings">Settings.</param>
    /// <param name="library">Library manager.</param>
    /// <param name="fileSystem">File system.</param>
    /// <param name="logger">Logger.</param>
    public ArclightIntroProvider(IntroAssets assets, IntroPolicy policy, IArclightSettings settings, ILibraryManager library, IFileSystem fileSystem, ILogger<ArclightIntroProvider> logger)
    {
        _assets = assets;
        _policy = policy;
        _settings = settings;
        _library = library;
        _fileSystem = fileSystem;
        _logger = logger;
    }

    /// <summary>Gets the provider name.</summary>
    public string Name => "Arclight intro";

    /// <inheritdoc />
    public async Task<IEnumerable<IntroInfo>> GetIntros(BaseItem item, JellyfinUser user)
    {
        var config = _settings.Config;
        var kind = item switch
        {
            Movie => "movie",
            Episode => "episode",
            _ => "other",
        };

        // Never put an intro in front of the intro itself.
        if (_assets.IsIntro(item.Path) || !_policy.ShouldPlay(config, kind, user?.Id ?? Guid.Empty, DateTimeOffset.UtcNow))
        {
            return Enumerable.Empty<IntroInfo>();
        }

        var path = _assets.PathFor(config.IntroQuality);
        var id = path is null ? null : await EnsureItemAsync(path).ConfigureAwait(false);
        return id is null ? Enumerable.Empty<IntroInfo>() : new[] { new IntroInfo { ItemId = id, Path = path } };
    }

    /// <summary>
    /// Jellyfin only plays intros that exist as items in its database (a bare path resolves to nothing),
    /// so the intro is registered once as a stand-alone video with no parent: it belongs to no library,
    /// so it never shows up in library views, search or Continue Watching. It is probed once so
    /// clients get its duration and streams.
    /// </summary>
    private async Task<Guid?> EnsureItemAsync(string path)
    {
        if (Registered.TryGetValue(path, out var known) && _library.GetItemById(known) is Video)
        {
            return known;
        }

        await Gate.WaitAsync().ConfigureAwait(false);
        try
        {
            var id = _library.GetNewItemId(path, typeof(Video));
            if (_library.GetItemById(id) is not Video video)
            {
                video = new Video
                {
                    Id = id,
                    Path = path,
                    Name = "Arclight intro",
                    DateCreated = DateTime.UtcNow,
                    DateModified = File.GetLastWriteTimeUtc(path),
                };
                _library.CreateItem(video, null);
                var options = new MetadataRefreshOptions(new DirectoryService(_fileSystem))
                {
                    MetadataRefreshMode = MetadataRefreshMode.FullRefresh,
                    ForceSave = true,
                    EnableRemoteContentProbe = false,
                };
                await video.RefreshMetadata(options, CancellationToken.None).ConfigureAwait(false);
                _logger.LogInformation("Arclight: registered the Cinema Mode intro {Path}", path);
            }

            Registered[path] = id;
            return id;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Arclight: could not register the intro {Path}", path);
            return null;
        }
        finally
        {
            Gate.Release();
        }
    }
}
