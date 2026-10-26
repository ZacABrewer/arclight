# First-run setup wizard

The first time you open Arclight in a browser, it shows a setup wizard instead of the dashboard. It creates your admin account, decides who else may sign in and what new accounts may do, connects the movie and TV database, tells Arclight where your media lives, and optionally adds a download client, an indexer and a VPN. This page explains each of the seven steps, what to type, what you can skip, and what to do if you close the tab halfway. You need Arclight running first: see [install-docker.md](install-docker.md) or pick your platform in [install-other-platforms.md](install-other-platforms.md).

## Before you open it

Have these ready:

| Item | Needed? | Notes |
|---|---|---|
| A username and password for yourself | Yes | The password must be at least 8 characters. |
| A TMDB API key | Yes | Free. Step 3 explains where to get it. |
| The folder paths as the container sees them | Yes | In the Docker files: `/data/media/tv` for TV and `/data/media/movies` for movies. Natively: real paths such as `D:\Media\TV`. |
| qBittorrent address and login | No | Only if you add qBittorrent yourself. The built-in engine is already registered and needs nothing. |
| An indexer (site, Torznab URL or API key) | No | You can add these later. |
| VPN details | No | You can set up the VPN later. |

Open `http://<your-host>:7878`. On a fresh install the app redirects you to `/setup`. The header shows "Step n of 7" and a row of steps you can click to move around once the admin account exists.

### Until the admin account exists

A fresh install has no accounts and no default password. Until you create the admin in step 1:

- every page (the login page and the request portal included) sends you to `/setup`;
- the api answers `403` with the code `SETUP_REQUIRED` on everything except the setup wizard's own calls (`/api/v1/setup/status`, `/api/v1/setup/admin`, `/api/v1/setup/complete`), `/api/v1/auth/status` and the health ping (`/api/v1/system/ping`, `/ping`). That includes calls made with the API key, the Sonarr/Radarr-compatible `/api/v3`, `/metrics` and the live event feed;
- "None on the local network" does not apply yet, so nobody gets in without the account;
- the other steps cannot be opened from the step row.

Once an admin exists, `/setup/admin` refuses a second one (409), and after **Finish setup** the wizard cannot run again.

## The seven steps

| # | Step | Required? | Skip button? |
|---|---|---|---|
| 1 | Admin | Yes | No |
| 2 | User defaults | Yes (the defaults are fine) | No |
| 3 | TMDB | Yes | No |
| 4 | Root folders | Yes (at least one) | No |
| 5 | Download client | Optional | "Skip for now", only while none is configured |
| 6 | Indexer | Optional | "Skip for now", only while none is configured |
| 7 | VPN, and how people sign in | Optional | "Skip for now" (also finishes setup) |

Each step has **Back** and **Continue** (or the step's own button). Your answers are saved as you go: the admin account the moment you create it, and each later step when you continue or add something.

## Step 1: Create the admin account

Heading: "Create the admin account". This is the account you sign in with, and it has full control. It is always a local Arclight account with a username and password: there is no option to use Jellyfin, Emby or Plex here, and admins can never sign in through a media server. You can add more people later under Settings > Users (see [users-and-security.md](../using/users-and-security.md)).

| Field | What to enter |
|---|---|
| Language | The language for the setup and for this account. "Auto" follows your browser; you can change it later in your profile. |
| Username | At least 2 characters. Letters, digits and `. _ @ -` only. Default `admin`. |
| Email (optional) | Optional. If you fill it in, it must look like an email address. |
| Password | At least 8 characters. |
| Confirm password | Same password again. |

Click **Create admin account**. Arclight creates the account and signs you in at once, so you do not see a login page. Nothing else on the page is needed. If it fails, a red box titled "Couldn't create the admin account" shows why.

There is no default password, and no account exists until you do this. The first person to open the page can create the admin, so complete this step before you give other people the address, and do not expose an unfinished setup to the internet.

## Step 2: User defaults

Heading: "Who else can sign in?". Everyone who is not an admin gets the request portal (Discover, their own requests and issues, their account), never the admin app. This step sets how those people sign in and what a new account starts with. Everything here can be changed later under Settings > Users.

| Part | Setting | Default | What it means |
|---|---|---|---|
| Sign-in | Arclight accounts | On | Users may sign in with an Arclight username and password. Admins always can, whatever you choose. |
| Sign-in | Jellyfin, Emby, Plex | On | Allows sign-in with that media server. It also needs the server's own sign-in switch under Settings > Media servers, so nothing is offered until you connect a server. |
| Sign-in | New people | Create an account on first sign-in | **Create an account on first sign-in**: anyone the media server knows can sign in and gets the defaults below. **Only people an admin added**: an admin adds, imports or links the account first. |
| Default request permissions | Request movies, Request series, Report issues | On | What a new account may do. |
| Default request permissions | Request in 4K | Off | |
| Default request permissions | Approve their requests automatically | Off | Off: an admin approves each request. |
| Default quotas | Movies, Series | Unlimited | How many requests per number of days. Leave empty for unlimited. |
| Default app access | Request portal only | Fixed | New accounts never get the app or admin rights by default. Grant read-only app access per user later. |

The permissions and quotas are the same values as **Default permissions for new users** and **Default quotas** in Settings > Requests. Click **Continue** to save.

## Step 3: Connect TMDB

Heading: "Connect TMDB". TMDB (The Movie Database) is where Arclight gets titles, posters, episode lists and release dates. Without a key it cannot look anything up, so this step cannot be skipped.

1. Create a free account at themoviedb.org.
2. In your TMDB account open Settings > API and create an API key. Use the **v3 API key**.
3. Paste the key into **TMDB API key**.
4. Click **Test key**. Arclight saves the key and runs a test search for "The Matrix". "The key works. A test search found N results." means it is good. A red message means the key was rejected or TMDB could not be reached.
5. Click **Continue**.

If a key is already saved (for example you set `ARCLIGHT_TMDB_API_KEY` in the environment), the step says so and you can continue without typing anything. Typing a new key replaces the saved one. Later you can change it under Settings > General. If this key is missing, System > Health shows [TMDB API key is missing](../TROUBLESHOOTING.md#tmdb-api-key-missing).

## Step 4: Choose root folders

Heading: "Where is your media stored?". A root folder is the top-level folder of your library. Arclight imports finished downloads into these and organises them in subfolders per show or movie. Add at least one folder for TV and one for movies.

1. Use the TV / Movies switch to pick which kind you are adding.
2. Type an absolute path, or browse. The browser lists folders as the Arclight server sees them (inside the container for Docker).
3. Click **Add**. The folder appears under "Added" with its kind and how much space is free.
4. The switch flips to the other kind, so you can add the second folder right away.
5. Click **Continue**. It refuses to continue with nothing added ("Add at least one root folder.").

What to type:

| Install | TV | Movies |
|---|---|---|
| Docker (the supplied compose files) | `/data/media/tv` | `/data/media/movies` |
| Native Windows | for example `D:\Media\TV` | for example `D:\Media\Movies` |

Rules the wizard enforces:

- The path must be absolute (`/...`, `D:\...` or `\\server\share`).
- A folder already added cannot be added again, so TV and movies need different folders.
- Folders may not sit inside each other.
- If the folder does not exist, Arclight creates it. It must be a folder the Arclight user can reach; otherwise the add fails with "Couldn't add ...". For permission errors see [permission denied](../TROUBLESHOOTING.md#permission-denied).
- **Remove** takes a folder out of Arclight's list. It does not delete any files.

In Docker always use the container paths (`/data/media/tv`, `/data/media/movies`), not the paths on the host. Both live under the single `/data` mount, which is what lets imports hard-link instantly instead of copying (see [install-docker.md](install-docker.md#the-folder-layout-one-share-one-mount)). If you see `/tv` or `/movies` in an older install, follow the [migration steps](install-docker.md#migrating-from-the-old-three-mount-layout). More about folders and hardlinks: [folders-and-hardlinks.md](folders-and-hardlinks.md). Afterwards you can manage root folders under Settings > Media Management ([media-management.md](../using/media-management.md)).

## Step 5: Download client (optional)

Heading: "Add a download client". A download client downloads the releases Arclight picks. The step shows the same Download Clients list you will find at Settings > Download Clients.

- **A client called Built-in is already set up.** On first start, when no client exists, Arclight registers one that uses its own torrent engine, so you can just click **Continue**. Its download folder defaults to `/data/downloads` when `/data` exists (older installs keep `/downloads`). Engine options are under Settings > Torrent Engine.
- **External clients are optional.** To add another one (for example qBittorrent), click **Add download client**; the built-in engine is listed first. For qBittorrent (started with `docker compose --profile qbittorrent up -d`) enter `localhost` and `8080` in the VPN layout (it shares the network with Arclight), or `qbittorrent` and `8080` in the no-VPN layout, add the username and password you set in qBittorrent, and test it before saving. In qBittorrent set Tools > Options > Downloads > Default Save Path to `/data/downloads` so both programs see the same paths (no remote path mapping needed).
- If you removed the built-in client and add nothing else, click **Skip for now**. Arclight can still search and manage the library, but it has nothing to download with until you add a client.

Field-by-field help, categories and the other clients are in [download-clients.md](../using/download-clients.md).

## Step 6: Indexer (optional)

Heading: "Add an indexer". Indexers are where Arclight searches for releases. The step embeds the Indexers page (Settings > Indexers). Click **Add indexer** to either pick a site from the catalogue or add a Torznab or Newznab endpoint, fill in what it asks for, and test it.

If you skip, Arclight has nowhere to search, so the Wanted and Search pages find nothing and System > Health shows [No indexers enabled](../TROUBLESHOOTING.md#no-indexers-enabled). That is fine for a first look, and you can add indexers any time. See [indexers.md](../using/indexers.md).

## Step 7: VPN and sign-in

Heading: "Protect downloads with a VPN". This is the last step and has two parts.

**VPN (optional).** The step embeds the VPN settings page (Settings > VPN). If you used a VPN compose file, choose provider **Gluetun (Docker)**, make sure the control server URL is `http://localhost:8000` (the default), and turn on **Enable VPN monitoring**. If you ran `scripts/gluetun-auth.sh`, the key is already supplied to Arclight by the compose file. Click **Test** to see State, Public IP and the forwarded port, then **Save**. Without a VPN leave monitoring off. Arclight pauses downloads when the tunnel drops. More in [vpn.md](../using/vpn.md).

**Sign-in.** Under "Sign-in", **How people sign in** sets how Arclight protects itself. You can change it later in Settings > Security.

| Option | What it means |
|---|---|
| Login page (recommended) | Everyone signs in with a username and password on a login page. |
| Browser prompt (HTTP Basic) | The browser asks for credentials in a pop-up. Mostly for tools that cannot show a login page. |
| None on the local network | No sign-in from addresses on your own network (private ranges). Addresses from the internet still need credentials. |

Click **Finish setup** (or **Skip for now**, which finishes with the same sign-in choice). Arclight marks setup complete and opens the dashboard. After that, `/setup` redirects to the dashboard and the wizard cannot be run again.

## If you leave halfway

| Situation | What happens |
|---|---|
| You close the tab after step 1 and come back in the same browser | The wizard resumes at the first required step you have not finished (User defaults keeps its defaults if you never saved it). |
| You come back in another browser or a private window | It says "An admin account already exists. Sign in with it to finish setup." Click **Sign in**, then you return to the wizard. |
| You lost your session during setup | The `/login` page stays reachable so the admin can sign back in and continue. |
| A step shows an error | Fix the value and click again. Earlier steps stay saved. |

## Check it worked

1. The dashboard opens after **Finish setup**.
2. System > Health lists any remaining problems, each linked to a fix. A fresh install with no indexers shows an indexer warning; that is expected.
3. Settings > Media Management shows your root folders.
4. If you set up a VPN, the dashboard has a VPN card showing Connected.

## Doing the same thing without the wizard

For scripted installs, `POST /api/v1/setup/complete` accepts the admin, TMDB key, root folders, sign-in method and the sign-in settings (`signIn`) in one request. It creates the admin only while none exists. See [API.md](../API.md). Settings can also be applied from a file; see [OPERATIONS.md](../OPERATIONS.md).

## Related

- [install-docker.md](install-docker.md)
- [install-other-platforms.md](install-other-platforms.md)
- [folders-and-hardlinks.md](folders-and-hardlinks.md)
- [../using/download-clients.md](../using/download-clients.md)
- [../using/indexers.md](../using/indexers.md)
- [../using/vpn.md](../using/vpn.md)
- [../using/users-and-security.md](../using/users-and-security.md)
- [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)
