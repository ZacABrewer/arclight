# Arclight app (Android, Google TV)

Arclight is the player app: it plays the movies, shows, music and audiobooks from your own Arclight server. One Android app works on phones, tablets and Google TV / Android TV; on a TV it switches to a layout made for the remote. It is not in Google Play yet, so for now you install it from the download on GitHub. (Arclight Admin, the companion app for running your server, is a different app; see [Mobile app](mobile-app.md).)

You need an Arclight server at 0.22.0 or later with the built-in player turned on and your account allowed to use it (see [Built-in player](player.md)).

## Install on a Google TV or Android TV

1. On the TV, open the Play Store and install **Downloader** (a free app by AFTVnews).
2. Allow it to install apps: Settings > Apps > Security & restrictions (or Device preferences > Security) > **Unknown sources**, and turn on Downloader. The menu names differ a little between TVs.
3. Open Downloader, type `arclight.moviemethat.com/tv` and press **Go**. It downloads the app; choose **Install**.
4. Open **Arclight** from the TV's apps row.

## Install on an Android phone or tablet

Open [arclight.moviemethat.com/android](https://arclight.moviemethat.com/android) on the phone, download the file and open it. Android asks once to allow installs from your browser.

## Sign in

- **TV:** enter your server's address with the remote (for example `http://<nas-ip>:7878` at home, or your HTTPS address). Then choose **Sign in with a code**: the TV shows a code and a QR code. On a phone or computer that is signed in to Arclight, scan the QR code or open the address the TV shows (`/player/link` on your server, or `<player address>/link` when an admin set a [player address](../player/address.md), such as `watch.example.com/link`) and type the code. The TV signs in by itself. You can also sign in with your password instead.
- **Phone:** enter the server address and sign in, or scan the **Sign in a phone** QR code from the web player.

## Who's watching?

If your account has two or more profiles, the app asks who is watching the first time you open it. A profile with a PIN asks for its 4 digits (on a TV with the on-screen number pad, on a phone with the number keyboard). Five wrong tries lock that profile for 15 minutes on that device. Each profile keeps its own My List, progress, settings and theme. Switch profiles from Settings > Profiles on a TV, or from your avatar in the top bar on a phone. On a phone, the avatar sheet also has **Request portal** (when your account may request) and **Open Arclight** (when your account may open part of the app). Both open in your phone's browser, which asks you to sign in. A TV shows neither. While your own (owner) profile is active you can add profiles from the picker's round **Add profile** tile, and edit them with the pencil **Manage profiles** button under the row (or under Settings > Profiles > Manage profiles): name, colour, PIN, Kids limit or delete. With only one profile, use **Settings > Profiles > Add profile** (or **Add profile** in the avatar sheet on a phone).

## Launch intro

When the app opens from cold, it plays a short Arclight intro while it loads; any key or a tap skips it. It never plays before a movie or episode, or when you come back to the app from the background. With Reduce motion on (in the app's Display settings or on the device) it shows a still frame instead. Turn it off with Settings > Display > Play intro on launch.

## Using it with a remote

On a TV the top bar has Home, TV Shows, Movies, My List and Search, with Music and Audiobooks (when they are turned on in Settings > Library) next to Settings. Arrow keys move between items, OK opens or plays, Back goes back: from a tab it returns to Home, and on Home it first jumps to the Home tab, then leaves the app. In the video player, OK shows the controls, left and right on the progress bar skip, and Back closes panels and then the player. Subtitles and audio tracks are under the controls.

## Updates

Install a newer download the same way; it replaces the app and keeps your sign-in. Every download is signed with the same key, so Android accepts it as an update. Each release's file is attached to its [GitHub release](https://github.com/ZacABrewer/arclight/releases).

## Related

- [Built-in player](player.md)
- [Mobile app (Arclight Admin)](mobile-app.md)
- [Exposing it outside your home](../getting-started/exposing-outside-home.md)
