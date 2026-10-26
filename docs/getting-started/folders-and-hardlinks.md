# Folders and hardlinks

This page explains how Arclight expects your folders to be laid out, why the layout matters, and how to check it worked. Read it before you create your shares and mount them into Docker. It is much easier to get right on day one than to fix later.

## Why one mount matters

> **Linux cannot hard-link a file across two different mounts, even when both are on the same disk.** If downloads and your library are mounted into the container as separate volumes, every import becomes a full copy: slower, and it uses double the disk space for as long as the torrent seeds. With one mount that contains both, an import is an instant hard link, and seeding keeps working.

So Arclight's compose files mount **one** share into both Arclight and qBittorrent:

| Where | Path in the container |
|---|---|
| Your whole data share (`DATA_ROOT` in `.env`) | `/data` |
| Downloads | `/data/downloads` |
| TV library | `/data/media/tv` |
| Movie library | `/data/media/movies` |

## The layout

```
/path/to/data                  <- DATA_ROOT: one share, one filesystem
  downloads/                   <- where downloads are saved
  media/
    tv/                        <- root folder in Arclight
    movies/                    <- root folder in Arclight
```

In your `.env` (see `docker/.env.example`):

```
CONFIG_ROOT=/path/to/appdata
DATA_ROOT=/path/to/data
```

The compose files do the rest: `${DATA_ROOT}:/data` is mounted into Arclight (and into qBittorrent, if you use it).

In Arclight, add your root folders as `/data/media/tv` and `/data/media/movies` (Settings > Media Management). Always enter paths as the container sees them, not the host paths.

The built-in torrent engine saves to `/data/downloads` by default when `/data` exists. Older installs that were created before this layout keep `/downloads`.

### If you use qBittorrent

In qBittorrent, open Options > Downloads and set the default save path to `/data/downloads`. Both containers then see exactly the same paths, so no remote path mapping is needed.

## What a hardlink is

A file on disk has data and one or more names pointing at that data. A hardlink is a second name for the same data. The file shows up in two folders, but the disk stores it once. Deleting one name leaves the other untouched.

Why you care: a torrent has to stay in your downloads folder to keep seeding, and you also want it in your library for Jellyfin, Emby or Plex. With a hardlink you get both for the price of one file.

A hardlink also needs both names on the same filesystem. Different disks, different volumes or different network shares cannot be linked.

## How an import picks hardlink, copy or move

When a download finishes, Arclight imports it into the library. The method depends on one setting and on what is possible:

| Situation | What Arclight does |
|---|---|
| The file can be handed over (for example a Manual Import with the move option) | **Move**: rename the file into the library. If the rename crosses filesystems, it makes a verified copy and then deletes the source. |
| The file must stay where it is (a torrent that is still seeding) and **Use hardlinks instead of copy** is on | **Hardlink**. If the link cannot be made (different mount or filesystem, a share that does not support links), it makes a full **copy** instead. |
| Same, with **Use hardlinks instead of copy** off | Always a full **copy**. |

The setting is under Settings > Media Management, in the file management section ("Use hardlinks instead of copy", default on, in the advanced view). Every option on that page is described in [media-management.md](../using/media-management.md).

Arclight does not stop an import when it falls back to a copy; the import still succeeds. A health check, "Hard links aren't possible between the download folder and a root folder", warns you when your layout prevents links. See [Hard links not possible](../TROUBLESHOOTING.md#hard-links-not-possible) and [Hardlinks not working](../TROUBLESHOOTING.md#hardlinks-not-working).

## Verify a hardlink

Do this after your first successful import. Replace the paths with your own.

1. Open a terminal on the host (SSH), or in the container (`docker exec -it <container-name> sh`).
2. List both names with their inode numbers and link counts:

   ```sh
   ls -li /data/downloads/Some.Show.S01E01.1080p/Some.Show.S01E01.mkv
   ls -li "/data/media/tv/Some Show/Season 01/Some Show - S01E01.mkv"
   ```

3. Read the first column (inode number) and the third column (link count).

A real hardlink: both lines show the same inode number, and the link count is 2.

```
1048577 -rw-r--r-- 2 1000 1000 1450000000 ... Some.Show.S01E01.mkv
1048577 -rw-r--r-- 2 1000 1000 1450000000 ... Some Show - S01E01.mkv
```

A copy: different inode numbers, and a link count of 1 on each.

You can also compare disk use. `du -sh` counts shared data once when run on the common parent, so `du -sh /data` is smaller than the two sub-folders added together when links are in use.

## Common mistakes

| Mistake | What happens | Fix |
|---|---|---|
| Downloads and library mounted into the container as separate volumes | Every import is a full copy | Mount one parent (`${DATA_ROOT}:/data`) |
| Library and downloads on different shares or volumes | Copy | Put them under one parent on one volume |
| **Use hardlinks instead of copy** turned off | Always copies | Turn it on |
| Network share (SMB or NFS) on the library side | Many shares refuse links, so Arclight copies | Use a local volume, or run Arclight on the NAS itself |
| qBittorrent saving to a different path than `/data/downloads` | Paths do not match; imports may be blocked | Set its default save path to `/data/downloads` |
| Host path typed where the container path is needed | Root folder shows as missing | Enter the path as the container sees it |
| Folder permissions do not let the container user write | Import fails (not a link problem) | See [Permission denied](../TROUBLESHOOTING.md#permission-denied) |

<a id="moving-an-existing-library"></a>
## Migrating from the old three-mount layout

Older compose files mounted `/tv`, `/movies` and `/downloads` separately (with `TV_ROOT`, `MOVIES_ROOT` and `DOWNLOADS_ROOT`). To move to the single `/data` mount:

1. Back up Arclight first: [backup-restore.md](backup-restore.md).
2. Stop the stack: `docker compose down`.
3. On the host, move your folders into one share, for example:

   ```
   /path/to/data/downloads
   /path/to/data/media/tv
   /path/to/data/media/movies
   ```

   Moving within one disk or volume is instant. If the old folders were on different disks, the files have to be copied across, which takes time.
4. Update your compose file and `.env` to the new version: remove `TV_ROOT`, `MOVIES_ROOT` and `DOWNLOADS_ROOT`, add `DATA_ROOT=/path/to/data`, and use `${DATA_ROOT}:/data` as the mount in Arclight and qBittorrent.
5. Start the stack: `docker compose up -d`.
6. In Arclight, edit your root folders in Settings > Media Management to `/data/media/tv` and `/data/media/movies`.
7. Change the built-in engine's download folder to `/data/downloads` in its settings (Settings > Torrent Engine). Installs that started on the old layout keep `/downloads` until you change it.
8. If you use qBittorrent, set its default save path to `/data/downloads` (Options > Downloads).
9. Run a library rescan so Arclight picks the files up at their new paths.
10. Check System > Health and do the [hardlink check](#verify-a-hardlink) on the next import.

Files that were copied earlier stay as separate copies; only new imports are hardlinked.

## Remote path mappings

You only need these when a download client reports paths that Arclight cannot open under the same name. With the layout above and qBittorrent saving to `/data/downloads`, you do not need any. They are for an external client on another machine, or one with its own different mounts.

Add them under Settings > Download Clients, in the "Remote path mappings" section. Each mapping has three fields:

| Field | What to enter |
|---|---|
| Host | The download client host this mapping applies to |
| Remote path | The path as the download client reports it |
| Local path | The same folder as Arclight sees it |

Example: a client on another machine saves to `/mnt/dl/tv`, while Arclight sees the same share as `/data/downloads/tv`. Add the client's host, remote path `/mnt/dl/tv`, local path `/data/downloads/tv`.

Remote paths may be Linux style or Windows style (for example `D:\Downloads`); Windows-style prefixes are matched without regard to upper or lower case, and the rest of the path is converted to the local style.

For hardlinks to work with a client on another machine, its download folder must be on the same filesystem and mount as your library as far as Arclight can tell, which usually means a shared network mount. In that case copying is often the realistic outcome. The health checks "Bad remote path mapping" and "Docker bad remote path mapping" appear when a reported path cannot be found. See [Import blocked or failed](../TROUBLESHOOTING.md#import-blocked-or-failed).

## Related

- [Requirements](requirements.md)
- [Install with Docker](install-docker.md)
- [Back up and restore](backup-restore.md)
- [Media management settings](../using/media-management.md)
- [Download clients](../using/download-clients.md)
- [Hard links not possible](../TROUBLESHOOTING.md#hard-links-not-possible)
- [Hardlinks not working](../TROUBLESHOOTING.md#hardlinks-not-working)
