// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using JellyfinUser = Jellyfin.Database.Implementations.Entities.User;

namespace Jellyfin.Plugin.Arclight.Labels;

/// <summary>Computes and caches quality labels from Jellyfin's own media info (no Arclight call).</summary>
public sealed class LabelService
{
    private const int MaxCache = 20000;
    private readonly ILibraryManager _library;
    private readonly IMediaSourceManager _sources;
    private readonly ConcurrentDictionary<Guid, (DateTime Modified, MediaLabelSet Labels)> _cache = new();

    /// <summary>Initializes a new instance of the <see cref="LabelService"/> class.</summary>
    /// <param name="library">Library manager.</param>
    /// <param name="sources">Media source manager.</param>
    public LabelService(ILibraryManager library, IMediaSourceManager sources)
    {
        _library = library;
        _sources = sources;
    }

    /// <summary>Labels for the given items that the user may see (movies, episodes and other videos only).</summary>
    /// <param name="ids">Item ids.</param>
    /// <param name="user">The caller.</param>
    /// <returns>Labels (items without video are left out).</returns>
    public List<MediaLabelSet> Get(IEnumerable<Guid> ids, JellyfinUser user)
    {
        var result = new List<MediaLabelSet>();
        foreach (var id in ids)
        {
            var item = _library.GetItemById(id);
            if (item is not Video video || !item.IsVisibleStandalone(user))
            {
                continue;
            }

            var modified = item.DateModified;
            if (_cache.TryGetValue(id, out var hit) && hit.Modified == modified)
            {
                result.Add(hit.Labels);
                continue;
            }

            var labels = Compute(video);
            if (_cache.Count >= MaxCache)
            {
                _cache.Clear();
            }

            _cache[id] = (modified, labels);
            result.Add(labels);
        }

        return result;
    }

    private MediaLabelSet Compute(Video video)
    {
        var source = _sources.GetStaticMediaSources(video, false, null).FirstOrDefault();
        var streams = (source?.MediaStreams ?? (IReadOnlyList<MediaBrowser.Model.Entities.MediaStream>)Array.Empty<MediaBrowser.Model.Entities.MediaStream>())
            .Select(s => new StreamFacts(
                s.Type.ToString(),
                s.Codec,
                s.Profile,
                s.Title,
                s.Width,
                s.Height,
                s.Channels,
                s.Language,
                s.IsDefault,
                s.Type == MediaBrowser.Model.Entities.MediaStreamType.Video ? s.VideoRangeType.ToString() : null))
            .ToList();
        return MediaLabels.Compute(video.Id.ToString("N"), streams, source?.Size);
    }
}
