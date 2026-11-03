// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.IO;
using System.Text;

namespace Jellyfin.Plugin.Arclight.Configuration;

/// <summary>
/// Keeps the Arclight API key in its own file under Jellyfin's plugin configuration folder, so it is
/// never part of the plugin configuration that Jellyfin serves to the dashboard, and it survives
/// plugin updates (the versioned plugin folder is replaced on update; the configurations folder is not).
/// </summary>
public sealed class SecretStore
{
    private const string FileName = "Jellyfin.Plugin.Arclight.apikey";
    private readonly object _lock = new();
    private readonly string _path;
    private string? _cached;
    private bool _loaded;

    /// <summary>Initializes a new instance of the <see cref="SecretStore"/> class.</summary>
    /// <param name="directory">Directory to keep the key file in.</param>
    public SecretStore(string directory)
    {
        _path = Path.Combine(directory, FileName);
    }

    /// <summary>Gets the API key, or an empty string when none is set.</summary>
    public string ApiKey
    {
        get
        {
            lock (_lock)
            {
                if (!_loaded)
                {
                    try
                    {
                        _cached = File.Exists(_path) ? File.ReadAllText(_path, Encoding.UTF8).Trim() : string.Empty;
                    }
                    catch (IOException)
                    {
                        _cached = string.Empty;
                    }
                    catch (UnauthorizedAccessException)
                    {
                        _cached = string.Empty;
                    }

                    _loaded = true;
                }

                return _cached ?? string.Empty;
            }
        }
    }

    /// <summary>Gets a short hint ("...abcd") for showing that a key is set without revealing it.</summary>
    public string Hint
    {
        get
        {
            var key = ApiKey;
            return key.Length == 0 ? string.Empty : key.Length <= 8 ? "set" : "..." + key[^4..];
        }
    }

    /// <summary>Saves a new key (empty clears it).</summary>
    /// <param name="apiKey">The key.</param>
    public void Set(string apiKey)
    {
        var value = (apiKey ?? string.Empty).Trim();
        lock (_lock)
        {
            if (value.Length == 0)
            {
                DeleteUnlocked();
            }
            else
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                var tmp = _path + ".tmp";
                WritePrivate(tmp, value);
                File.Move(tmp, _path, true);
                TryRestrictPermissions(_path);
            }

            _cached = value;
            _loaded = true;
        }
    }

    /// <summary>Deletes the key file.</summary>
    public void Delete()
    {
        lock (_lock)
        {
            DeleteUnlocked();
            _cached = string.Empty;
            _loaded = true;
        }
    }

    /// <summary>
    /// Writes <paramref name="value"/> to a new file that is owner-only (0600) from the moment it exists,
    /// so there is no window in which another local user could open it. A leftover temp file from an
    /// interrupted save is removed first, because the create mode only applies to new files.
    /// </summary>
    /// <param name="path">Temp file path.</param>
    /// <param name="value">Content.</param>
    internal static void WritePrivate(string path, string value)
    {
        if (File.Exists(path))
        {
            File.Delete(path);
        }

        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        using var stream = new FileStream(path, options);
        var bytes = new UTF8Encoding(false).GetBytes(value);
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush(true);
    }

    private static void TryRestrictPermissions(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        try
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        catch (Exception)
        {
            // Best effort only.
        }
    }

    private void DeleteUnlocked()
    {
        try
        {
            if (File.Exists(_path))
            {
                File.Delete(_path);
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
