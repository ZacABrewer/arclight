// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Threading.Tasks;
using Jellyfin.Data.Events.Users;
using MediaBrowser.Controller.Events;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Arclight.Events;

/// <summary>
/// Receives Jellyfin's user lifecycle events (published through <see cref="IEventManager"/>) and
/// forwards them. Registered as scoped <see cref="IEventConsumer{T}"/> implementations.
/// </summary>
public sealed class UserEventConsumers :
    IEventConsumer<UserCreatedEventArgs>,
    IEventConsumer<UserUpdatedEventArgs>,
    IEventConsumer<UserDeletedEventArgs>
{
    private readonly EventIngest _ingest;
    private readonly ILogger<UserEventConsumers> _logger;

    /// <summary>Initializes a new instance of the <see cref="UserEventConsumers"/> class.</summary>
    /// <param name="ingest">Ingest.</param>
    /// <param name="logger">Logger.</param>
    public UserEventConsumers(EventIngest ingest, ILogger<UserEventConsumers> logger)
    {
        _ingest = ingest;
        _logger = logger;
    }

    /// <inheritdoc />
    public Task OnEvent(UserCreatedEventArgs eventArgs) => Handle(EventTypes.UserCreated, eventArgs.Argument);

    /// <inheritdoc />
    public Task OnEvent(UserUpdatedEventArgs eventArgs) => Handle(EventTypes.UserUpdated, eventArgs.Argument);

    /// <inheritdoc />
    public Task OnEvent(UserDeletedEventArgs eventArgs) => Handle(EventTypes.UserDeleted, eventArgs.Argument);

    private Task Handle(string type, Jellyfin.Database.Implementations.Entities.User? user)
    {
        try
        {
            if (user is not null)
            {
                _ingest.User(type, user.Id, user.Username);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Arclight: failed to handle {Event}", type);
        }

        return Task.CompletedTask;
    }
}
