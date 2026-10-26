# Notices

Arclight is licensed under the GNU General Public License v3.0 (see LICENSE).

Arclight is an independent, from-scratch implementation. It does not incorporate source
code from any of the projects below. Their public behaviour, documentation and API shapes
informed the behaviour specifications in `docs/spec/`, and the authors of those projects
deserve credit for a decade of figuring out how this problem space works.

| Project | Upstream | Informed |
|---|---|---|
| Sonarr | https://github.com/Sonarr/Sonarr | TV library model, parser behaviour, pipeline |
| Radarr | https://github.com/Radarr/Radarr | Movie library model, custom formats, editions |
| Prowlarr | https://github.com/Prowlarr/Prowlarr | Indexer definitions, proxies, stats |
| Bazarr | https://github.com/morpheus65535/bazarr | Subtitle language profiles, scoring, providers |
| Seerr | https://github.com/seerr-team/seerr | Requests, permissions, discover |

qBittorrent runs as a separate container and is not part of Arclight.
