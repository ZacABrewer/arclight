// SPDX-License-Identifier: GPL-3.0-or-later
using System.Collections.Generic;
using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Arclight.Configuration;

/// <summary>
/// Plugin settings stored by Jellyfin as XML. The Arclight API key is deliberately NOT here:
/// Jellyfin returns this object to the dashboard, so the key lives in <see cref="SecretStore"/>.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Gets or sets the Arclight base URL, e.g. https://arclight.example.com.</summary>
    public string ArclightUrl { get; set; } = string.Empty;

    /// <summary>Gets or sets a value indicating whether events are forwarded at all.</summary>
    public bool EnableEventForwarding { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether playback start/progress/stop is forwarded.</summary>
    public bool EnablePlaybackEvents { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether played/favourite changes are forwarded.</summary>
    public bool EnableUserDataEvents { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether newly added library items are forwarded.</summary>
    public bool EnableLibraryEvents { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether user created/updated/deleted is forwarded.</summary>
    public bool EnableUserEvents { get; set; } = true;

    /// <summary>Gets or sets how often the event queue is flushed, in seconds (2-300).</summary>
    public int BatchIntervalSeconds { get; set; } = 10;

    /// <summary>Gets or sets the minimum seconds between progress events for one session (10-600).</summary>
    public int ProgressThrottleSeconds { get; set; } = 60;

    /// <summary>Gets or sets the maximum number of queued events kept in memory (500-50000).</summary>
    public int MaxQueueSize { get; set; } = 5000;

    /// <summary>Gets or sets a value indicating whether the web script is injected into Jellyfin Web.</summary>
    public bool EnableWebInjection { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether index.html on disk is patched as a fallback.</summary>
    public bool PatchIndexHtmlOnDisk { get; set; }

    /// <summary>Gets or sets a value indicating whether the Arclight section is added to Jellyfin search.</summary>
    public bool EnableSearch { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether users may request titles from Jellyfin.</summary>
    public bool EnableRequests { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether status chips are shown on item pages.</summary>
    public bool EnableItemBadges { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the watchlist button is shown.</summary>
    public bool EnableWatchlist { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether "Report a problem" is shown.</summary>
    public bool EnableIssues { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether subtitle/audio language requests are shown.</summary>
    public bool EnableLanguageRequests { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the Discover page is available.</summary>
    public bool EnableDiscover { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the "Coming soon" row is shown.</summary>
    public bool EnableUpcoming { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether "Also on" streaming providers are shown.</summary>
    public bool EnableProviders { get; set; } = true;

    /// <summary>Gets or sets the two-letter region for streaming providers.</summary>
    public string ProvidersRegion { get; set; } = "US";

    /// <summary>Gets or sets a value indicating whether the "My requests" page is available.</summary>
    public bool EnableMyRequests { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether quality/audio labels are shown on posters.</summary>
    public bool EnableLabels { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the "My stats" page is available (Arclight decides who may see it).</summary>
    public bool EnableMyStats { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the "Year in review" page is available (Arclight decides who may see it).</summary>
    public bool EnableWrapped { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the "Server stats" page is available (Arclight decides who may see it).</summary>
    public bool EnableServerStats { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the "Leaving Soon" Discover row is shown (when on in Arclight).</summary>
    public bool EnableLeavingSoon { get; set; } = true;

    /// <summary>Gets or sets the default Jellyfin theme: empty = off, "follow" = each user's Arclight theme, or a pack id.</summary>
    public string DefaultTheme { get; set; } = string.Empty;

    /// <summary>Gets or sets a value indicating whether users may pick their own theme.</summary>
    public bool LetUsersChooseTheme { get; set; } = true;

    /// <summary>Gets or sets per-user theme choices (survive across that user's devices).</summary>
    public List<UserThemeChoice> UserThemes { get; set; } = new();

    /// <summary>Gets or sets a value indicating whether the Arclight intro plays in Cinema Mode (opt-in).</summary>
    public bool EnableIntro { get; set; }

    /// <summary>Gets or sets a value indicating whether the intro plays before movies.</summary>
    public bool IntroBeforeMovies { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the intro plays before episodes.</summary>
    public bool IntroBeforeEpisodes { get; set; }

    /// <summary>Gets or sets a value indicating whether episodes only get it at the start of a session (no intro in the last 3 hours).</summary>
    public bool IntroFirstEpisodeOnly { get; set; } = true;

    /// <summary>Gets or sets the intro quality: 1080p or 720p.</summary>
    public string IntroQuality { get; set; } = "1080p";

    /// <summary>Gets or sets Jellyfin user ids that never get the intro.</summary>
    public List<string> IntroSkipUsers { get; set; } = new();
}

/// <summary>A Jellyfin user's theme choice.</summary>
public class UserThemeChoice
{
    /// <summary>Gets or sets the Jellyfin user id ("N" format).</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>Gets or sets "off", "follow", or a pack id.</summary>
    public string Theme { get; set; } = string.Empty;
}
