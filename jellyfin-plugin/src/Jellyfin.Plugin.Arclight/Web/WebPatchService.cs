// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Model.Plugins;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Arclight.Web;

/// <summary>Applies or removes the optional on-disk index.html patch at startup and on config changes.</summary>
public sealed class WebPatchService : IHostedService
{
    private readonly IApplicationPaths _paths;
    private readonly InjectionStatus _status;
    private readonly ILogger<WebPatchService> _logger;

    /// <summary>Initializes a new instance of the <see cref="WebPatchService"/> class.</summary>
    /// <param name="paths">Application paths.</param>
    /// <param name="status">Status tracker.</param>
    /// <param name="logger">Logger.</param>
    public WebPatchService(IApplicationPaths paths, InjectionStatus status, ILogger<WebPatchService> logger)
    {
        _paths = paths;
        _status = status;
        _logger = logger;
    }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        Apply();
        if (Plugin.Instance is { } plugin)
        {
            plugin.ConfigurationChanged += OnConfigurationChanged;
        }

        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken)
    {
        if (Plugin.Instance is { } plugin)
        {
            plugin.ConfigurationChanged -= OnConfigurationChanged;
        }

        return Task.CompletedTask;
    }

    private void OnConfigurationChanged(object? sender, BasePluginConfiguration e) => Apply();

    private void Apply()
    {
        try
        {
            var config = Plugin.Instance?.Configuration;
            if (config is null)
            {
                return;
            }

            _status.DiskPatch = config.EnableWebInjection && config.PatchIndexHtmlOnDisk
                ? IndexFilePatcher.TryPatchOnDisk(_paths.WebPath, _logger)
                : IndexFilePatcher.TryRemoveFromDisk(_paths.WebPath, _logger);
        }
        catch (Exception ex)
        {
            _status.DiskPatch = "error: " + ex.Message;
            _logger.LogWarning(ex, "Arclight: on-disk web patch failed");
        }
    }
}
