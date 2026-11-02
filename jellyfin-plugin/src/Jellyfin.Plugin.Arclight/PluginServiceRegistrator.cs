// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using Jellyfin.Data.Events.Users;
using Jellyfin.Plugin.Arclight.Arclight;
using Jellyfin.Plugin.Arclight.Events;
using Jellyfin.Plugin.Arclight.Web;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Arclight;

/// <summary>Registers the plugin's services with Jellyfin's container.</summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<IArclightSettings, PluginSettings>();
        serviceCollection.AddSingleton<ArclightClient>();
        serviceCollection.AddSingleton(sp => new EventQueue(Math.Clamp(sp.GetRequiredService<IArclightSettings>().Config.MaxQueueSize, 500, 50000)));
        serviceCollection.AddSingleton(sp => new EventIngest(sp.GetRequiredService<EventQueue>(), sp.GetRequiredService<IArclightSettings>()));
        serviceCollection.AddSingleton(sp => new EventSender(
            sp.GetRequiredService<EventQueue>(),
            sp.GetRequiredService<ArclightClient>(),
            sp.GetRequiredService<IArclightSettings>(),
            () => sp.GetRequiredService<IServerApplicationHost>().SystemId,
            sp.GetRequiredService<ILogger<EventSender>>()));
        serviceCollection.AddSingleton<InjectionStatus>();
        serviceCollection.AddSingleton<Labels.LabelService>();
        serviceCollection.AddSingleton<ThemeCache>();

        serviceCollection.AddHostedService<EventForwarder>();
        serviceCollection.AddHostedService<WebPatchService>();

        serviceCollection.AddScoped<IEventConsumer<UserCreatedEventArgs>, UserEventConsumers>();
        serviceCollection.AddScoped<IEventConsumer<UserUpdatedEventArgs>, UserEventConsumers>();
        serviceCollection.AddScoped<IEventConsumer<UserDeletedEventArgs>, UserEventConsumers>();

        // Rewrites Jellyfin Web's index.html on the fly to load the Arclight script (see README).
        serviceCollection.AddTransient<IStartupFilter, ScriptInjectionStartupFilter>();
    }
}
