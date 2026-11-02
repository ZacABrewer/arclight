// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.Arclight.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.Arclight;

/// <summary>
/// Arclight for Jellyfin: forwards playback/library/user events to an Arclight server and lets
/// Jellyfin Web users search, request and track titles through Arclight.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>The fixed plugin id. Never change it: Jellyfin and the repository manifest key on it.</summary>
    public const string PluginGuid = "a0751e21-86da-4afd-8e35-7da8b087febc";

    /// <summary>Display name, also the name in the repository manifest.</summary>
    public const string PluginName = "Arclight";

    private readonly SecretStore _secrets;

    /// <summary>Initializes a new instance of the <see cref="Plugin"/> class.</summary>
    /// <param name="applicationPaths">Application paths.</param>
    /// <param name="xmlSerializer">XML serializer.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        _secrets = new SecretStore(applicationPaths.PluginConfigurationsPath);
    }

    /// <summary>Gets the running instance (Jellyfin creates exactly one).</summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override string Name => PluginName;

    /// <inheritdoc />
    public override Guid Id => Guid.Parse(PluginGuid);

    /// <inheritdoc />
    public override string Description => "Connects Jellyfin to your Arclight server: watch-state sync, requests, status badges and watchlist.";

    /// <summary>Gets the store holding the Arclight API key outside the plugin XML configuration.</summary>
    internal SecretStore Secrets => _secrets;

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = Name,
                EmbeddedResourcePath = string.Format(CultureInfo.InvariantCulture, "{0}.Configuration.configPage.html", GetType().Namespace),
            },
        };
    }

    /// <inheritdoc />
    public override void OnUninstalling()
    {
        _secrets.Delete();
        Web.IndexFilePatcher.TryRemoveFromDisk(ApplicationPaths.WebPath, null);
        base.OnUninstalling();
    }
}
