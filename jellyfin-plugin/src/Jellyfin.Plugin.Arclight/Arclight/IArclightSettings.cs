// SPDX-License-Identifier: GPL-3.0-or-later
using Jellyfin.Plugin.Arclight.Configuration;

namespace Jellyfin.Plugin.Arclight.Arclight;

/// <summary>Read access to the current settings (abstracted so tests need no Jellyfin host).</summary>
public interface IArclightSettings
{
    /// <summary>Gets the configured Arclight base URL.</summary>
    string ArclightUrl { get; }

    /// <summary>Gets the configured API key.</summary>
    string ApiKey { get; }

    /// <summary>Gets the current plugin configuration.</summary>
    PluginConfiguration Config { get; }
}

/// <summary>Settings backed by the running plugin instance.</summary>
public sealed class PluginSettings : IArclightSettings
{
    private static readonly PluginConfiguration Defaults = new();

    /// <inheritdoc />
    public string ArclightUrl => Plugin.Instance?.Configuration.ArclightUrl ?? string.Empty;

    /// <inheritdoc />
    public string ApiKey => Plugin.Instance?.Secrets.ApiKey ?? string.Empty;

    /// <inheritdoc />
    public PluginConfiguration Config => Plugin.Instance?.Configuration ?? Defaults;
}
