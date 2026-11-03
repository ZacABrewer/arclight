import type { PluginListenerHandle } from '@capacitor/core';
import type {
  PlayableItem,
  PlaybackProgress,
  PlayerAlbum,
  PlayerAlbumDetails,
  PlayerArtist,
  PlayerArtistDetails,
  PlayerAudiobook,
  PlayerSearchResponse,
  PlayerTrack,
  UserPlaylistDetails,
  UserPlaylistSummary,
} from '@arclight/shared';
import { t } from '@web/i18n/index';
import type { ArclightPlayerPlugin, BrowseNode, BrowsePlayEvent, BrowseRequestEvent, BrowseTree } from '../native/definitions';
import type { PlayItemsOptions } from '@web/features/player/player-controller';

// The car's media browser (CarPlay, Android Auto). Native asks for a node's children with
// `browseRequest` and JS answers with `answerBrowse` (from the server when online, from the
// downloads when not); `setBrowseTree` keeps a copy native shows while JS is suspended. A pick
// arrives as `browsePlay` and becomes a queue on the player.
//
// Node ids: root sections "continue", "albums", "artists", "playlists", "books", "downloads";
// then "album:<id>", "artist:<id>", "playlist:<id>", "book:<id>"; a track's id is its item key
// ("track:<id>"), and continue / downloaded audiobooks use theirs ("audiobook:<id>").

export const CAR_ROOT = ['continue', 'albums', 'artists', 'playlists', 'books', 'downloads'] as const;
export type CarSection = (typeof CAR_ROOT)[number];

/** Native waits ~5 s for an answer; answer from the downloads before that when the server is slow. */
const ANSWER_WITHIN_MS = 4_000;
/** Rows per list (cars show short lists; drivers should not scroll). */
const LIST_MAX = 100;
const SEARCH_MAX = 30;

/** A downloaded item (completed) of the active account. */
export interface CarDownload {
  item: PlayableItem;
  /** Local cover file, when downloaded. */
  artworkPath?: string | undefined;
}

/** Where the car's lists come from (injectable for tests). */
export interface CarLibrary {
  online(): boolean;
  continueListening(): Promise<Array<{ item: PlayableItem; progress: PlaybackProgress }>>;
  albums(): Promise<PlayerAlbum[]>;
  album(id: number): Promise<PlayerAlbumDetails>;
  artists(): Promise<PlayerArtist[]>;
  artist(id: number): Promise<PlayerArtistDetails>;
  playlists(): Promise<UserPlaylistSummary[]>;
  playlist(id: number): Promise<UserPlaylistDetails>;
  books(): Promise<PlayerAudiobook[]>;
  search(query: string): Promise<PlayerSearchResponse>;
  downloads(): CarDownload[];
}

export interface CarPlayer {
  playItems(itemKeys: readonly string[], opts?: PlayItemsOptions): Promise<void>;
  playItem(itemKey: string, opts?: { source?: string | null }): Promise<void>;
}

export interface CarBrowserDeps {
  plugin: ArclightPlayerPlugin;
  library: CarLibrary;
  player: () => CarPlayer;
  /** Fires when the downloads or the network change (re-send the cached tree). */
  onChange?: (listener: () => void) => () => void;
  answerWithinMs?: number;
}

const httpOrFile = (url: string | null | undefined): string | undefined => (url && /^(https?:|file:|\/)/.test(url) ? url : undefined);

interface NodeOptions {
  browsable?: boolean;
  playable?: boolean;
  subtitle?: string | undefined;
  artworkUrl?: string | undefined;
  progress?: number | undefined;
}

function node(id: string, title: string, o: NodeOptions = {}): BrowseNode {
  const n: BrowseNode = { id, title, browsable: o.browsable ?? false, playable: o.playable ?? false };
  if (o.subtitle) n.subtitle = o.subtitle;
  if (o.artworkUrl) n.artworkUrl = o.artworkUrl;
  if (o.progress !== undefined) n.progress = Math.max(0, Math.min(1, o.progress));
  return n;
}

const trackNode = (tr: PlayerTrack) => node(tr.itemKey, tr.title, { playable: true, subtitle: tr.artistName, artworkUrl: httpOrFile(tr.artworkUrl) });
const albumNode = (a: PlayerAlbum) => node(`album:${a.id}`, a.title, { browsable: true, playable: true, subtitle: a.artistName, artworkUrl: httpOrFile(a.artworkUrl) });
const artistNode = (a: PlayerArtist) => node(`artist:${a.id}`, a.name, { browsable: true, artworkUrl: httpOrFile(a.imageUrl) });
const playlistNode = (p: UserPlaylistSummary) => node(`playlist:${p.id}`, p.name, { browsable: true, playable: true, artworkUrl: httpOrFile(p.artworkUrls[0]) });
const bookNode = (b: PlayerAudiobook) =>
  node(`book:${b.id}`, b.title, {
    playable: true,
    subtitle: b.authors.join(', '),
    artworkUrl: httpOrFile(b.artworkUrl),
    ...(b.progress && b.durationMs > 0 ? { progress: b.progress.positionMs / b.durationMs } : {}),
  });
const itemNode = (item: PlayableItem, art?: string, progress?: number) =>
  node(item.itemKey, item.title, {
    playable: true,
    subtitle: item.subtitle ?? undefined,
    artworkUrl: httpOrFile(art) ?? httpOrFile(item.artworkUrl),
    ...(progress !== undefined ? { progress } : {}),
  });

function parseId(nodeId: string, prefix: string): number | null {
  if (!nodeId.startsWith(`${prefix}:`)) return null;
  const n = Number(nodeId.slice(prefix.length + 1));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class CarBrowser {
  private handles: Array<Promise<PluginListenerHandle>> = [];
  private offChange: (() => void) | null = null;
  private treeTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(private readonly deps: CarBrowserDeps) {}

  start(): void {
    const { plugin } = this.deps;
    this.handles.push(plugin.addListener('browseRequest', (e) => void this.onRequest(e)));
    this.handles.push(plugin.addListener('browsePlay', (e) => void this.onPlay(e)));
    this.offChange = this.deps.onChange?.(() => this.scheduleTree()) ?? null;
    void this.pushTree();
  }

  destroy(): void {
    this.destroyed = true;
    this.offChange?.();
    if (this.treeTimer) clearTimeout(this.treeTimer);
    for (const h of this.handles) void h.then((x) => x.remove()).catch(() => undefined);
    this.handles = [];
  }

  // ---------------------------------------------------------------- lists

  rootNodes(): BrowseNode[] {
    return CAR_ROOT.map((id) => node(id, t(`app.car.${id}`), { browsable: true }));
  }

  /** Children of a node: from the server when online (downloads when that is slow or fails). */
  async children(parentId: string): Promise<BrowseNode[]> {
    if (parentId === 'root') return this.rootNodes();
    if (!this.deps.library.online() || parentId === 'downloads') return this.offlineChildren(parentId);
    try {
      return await withTimeout(this.onlineChildren(parentId), this.deps.answerWithinMs ?? ANSWER_WITHIN_MS);
    } catch {
      return this.offlineChildren(parentId);
    }
  }

  private async onlineChildren(parentId: string): Promise<BrowseNode[]> {
    const lib = this.deps.library;
    switch (parentId) {
      case 'continue':
        return (await lib.continueListening())
          .slice(0, LIST_MAX)
          .map(({ item, progress }) => itemNode(item, undefined, item.durationMs > 0 ? progress.positionMs / item.durationMs : undefined));
      case 'albums':
        return (await lib.albums()).slice(0, LIST_MAX).map(albumNode);
      case 'artists':
        return (await lib.artists()).slice(0, LIST_MAX).map(artistNode);
      case 'playlists':
        return (await lib.playlists()).slice(0, LIST_MAX).map(playlistNode);
      case 'books':
        return (await lib.books()).slice(0, LIST_MAX).map(bookNode);
    }
    const album = parseId(parentId, 'album');
    if (album !== null) return (await lib.album(album)).tracks.map(trackNode);
    const artist = parseId(parentId, 'artist');
    if (artist !== null) return (await lib.artist(artist)).albums.slice(0, LIST_MAX).map(albumNode);
    const playlist = parseId(parentId, 'playlist');
    if (playlist !== null) return (await lib.playlist(playlist)).tracks.slice(0, LIST_MAX * 5).map(trackNode);
    return [];
  }

  /** The same lists built from what is downloaded. */
  offlineChildren(parentId: string): BrowseNode[] {
    const all = this.deps.library.downloads();
    const tracks = all.filter((d) => d.item.kind === 'track');
    const art = (d: CarDownload) => d.artworkPath;
    switch (parentId) {
      case 'continue':
      case 'playlists':
        return [];
      case 'downloads':
        return all.slice(0, LIST_MAX * 5).map((d) => itemNode(d.item, art(d)));
      case 'books':
        return all.filter((d) => d.item.kind === 'audiobook').map((d) => itemNode(d.item, art(d)));
      case 'albums': {
        const seen = new Map<number, BrowseNode>();
        for (const d of tracks) {
          const id = d.item.albumId;
          if (id === null || seen.has(id)) continue;
          seen.set(id, node(`album:${id}`, d.item.context ?? t('app.car.albums'), { browsable: true, playable: true, subtitle: d.item.subtitle ?? undefined, artworkUrl: httpOrFile(art(d)) }));
        }
        return [...seen.values()];
      }
      case 'artists': {
        const seen = new Map<number, BrowseNode>();
        for (const d of tracks) {
          const id = d.item.artistId;
          if (id === null || seen.has(id)) continue;
          seen.set(id, node(`artist:${id}`, d.item.subtitle ?? t('app.car.artists'), { browsable: true }));
        }
        return [...seen.values()];
      }
    }
    const album = parseId(parentId, 'album');
    if (album !== null) return tracks.filter((d) => d.item.albumId === album).map((d) => itemNode(d.item, art(d)));
    const artist = parseId(parentId, 'artist');
    if (artist !== null) {
      const seen = new Map<number, BrowseNode>();
      for (const d of tracks) {
        const id = d.item.albumId;
        if (d.item.artistId !== artist || id === null || seen.has(id)) continue;
        seen.set(id, node(`album:${id}`, d.item.context ?? t('app.car.albums'), { browsable: true, playable: true, subtitle: d.item.subtitle ?? undefined, artworkUrl: httpOrFile(art(d)) }));
      }
      return [...seen.values()];
    }
    return [];
  }

  async search(query: string): Promise<BrowseNode[]> {
    const q = query.trim();
    if (!q) return [];
    if (this.deps.library.online()) {
      try {
        const res = await withTimeout(this.deps.library.search(q), this.deps.answerWithinMs ?? ANSWER_WITHIN_MS);
        return [...res.albums.map(albumNode), ...res.tracks.map(trackNode), ...res.audiobooks.map(bookNode), ...res.artists.map(artistNode)].slice(0, SEARCH_MAX);
      } catch {
        // fall through to the downloads
      }
    }
    const needle = q.toLowerCase();
    return this.deps.library
      .downloads()
      .filter((d) => [d.item.title, d.item.subtitle, d.item.context].some((s) => s?.toLowerCase().includes(needle)))
      .slice(0, SEARCH_MAX)
      .map((d) => itemNode(d.item, d.artworkPath));
  }

  /** Root and its sections, cached natively for when JS cannot answer (suspended, offline). */
  async tree(): Promise<BrowseTree> {
    const children: Record<string, BrowseNode[]> = {};
    await Promise.all(
      CAR_ROOT.map(async (id) => {
        children[id] = await this.children(id).catch(() => this.offlineChildren(id));
      }),
    );
    // Downloaded albums open without JS too.
    for (const n of this.offlineChildren('albums')) children[n.id] ??= this.offlineChildren(n.id);
    return { root: this.rootNodes(), children };
  }

  private scheduleTree(): void {
    if (this.treeTimer) clearTimeout(this.treeTimer);
    this.treeTimer = setTimeout(() => {
      this.treeTimer = null;
      void this.pushTree();
    }, 1_000);
  }

  private async pushTree(): Promise<void> {
    try {
      const tree = await this.tree();
      if (!this.destroyed) await this.deps.plugin.setBrowseTree(tree);
    } catch (e) {
      console.warn('car browse tree', e);
    }
  }

  // ---------------------------------------------------------------- native events

  private async onRequest(e: BrowseRequestEvent): Promise<void> {
    let items: BrowseNode[] = [];
    try {
      items = e.query !== undefined && e.parentId === undefined ? await this.search(e.query) : await this.children(e.parentId ?? 'root');
    } catch {
      items = [];
    }
    if (this.destroyed) return;
    await this.deps.plugin.answerBrowse({ requestId: e.requestId, items }).catch(() => undefined);
  }

  /** Item keys of the playable tracks under a list node, in order. */
  private async trackKeys(parentId: string): Promise<string[]> {
    const nodes = await this.children(parentId);
    return nodes.filter((n) => n.id.startsWith('track:') || n.id.startsWith('audiobook:')).map((n) => n.id);
  }

  async onPlay(e: BrowsePlayEvent): Promise<void> {
    const player = this.deps.player();
    const id = e.nodeId;
    const book = parseId(id, 'book');
    if (book !== null) return player.playItem(`audiobook:${book}`, { source: `audiobook:${book}` });
    if (id.startsWith('album:') || id.startsWith('playlist:')) {
      const keys = await this.trackKeys(id);
      if (keys.length) await player.playItems(keys, { source: id });
      return;
    }
    if (id.startsWith('track:') || id.startsWith('audiobook:')) {
      const parent = e.parentId;
      // Picked from a list of tracks: queue the list, starting at the pick.
      if (parent && (parent.startsWith('album:') || parent.startsWith('playlist:') || parent === 'downloads')) {
        const keys = await this.trackKeys(parent);
        const startIndex = keys.indexOf(id);
        if (startIndex >= 0) {
          await player.playItems(keys, { startIndex, source: parent === 'downloads' ? null : parent });
          return;
        }
      }
      await player.playItem(id, id.startsWith('audiobook:') ? { source: id } : {});
    }
  }
}
