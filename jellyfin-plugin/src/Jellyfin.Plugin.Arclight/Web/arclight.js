/*
 * Arclight for Jellyfin - Jellyfin Web integration.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Loaded into Jellyfin Web by the Arclight plugin. Talks only to this Jellyfin server's /Arclight/*
 * endpoints with the signed-in user's own Jellyfin token; the plugin forwards to Arclight server-side.
 * Plain ES2017, no build step, no globals other than window.__arclight.
 */
(function () {
  'use strict';

  if (window.__arclight) {
    return;
  }

  // ------------------------------------------------------------------ i18n
  var STRINGS = {
    en: {
      sectionTitle: 'Not in your library',
      sectionSubtitle: 'Request with Arclight',
      request: 'Request',
      request4k: 'Request in 4K',
      qualityProfile: 'Quality profile',
      defaultProfile: 'Default',
      requested: 'Requested',
      processing: 'Processing',
      available: 'Available',
      partial: 'Partly available',
      requestTitle: 'Request {title}',
      seasons: 'Seasons',
      allSeasons: 'All seasons',
      season: 'Season {n}',
      specials: 'Specials',
      cancel: 'Cancel',
      submit: 'Submit',
      close: 'Close',
      requestSent: 'Request sent for {title}',
      requestedBy: 'Requested by {name}',
      requestedPending: 'Requested by {name} · awaiting approval',
      downloading: 'Downloading {pct}%',
      downloadingEta: 'Downloading {pct}% · ETA {eta}',
      downloadQueued: 'Download queued',
      downloadPaused: 'Download paused',
      importing: 'Importing',
      comingOn: 'Coming {date}',
      missingEpisodes: '{n} missing episodes',
      missingEpisode: '1 missing episode',
      requestMissing: 'Request missing',
      notMonitored: 'Not monitored in Arclight',
      watchlistAdd: 'Add to watchlist',
      watchlistRemove: 'On watchlist',
      watchlistAdded: 'Added to your Arclight watchlist',
      watchlistRemoved: 'Removed from your Arclight watchlist',
      reportProblem: 'Report a problem',
      issueType: 'What is wrong?',
      issueVideo: 'Video',
      issueAudio: 'Audio',
      issueSubtitles: 'Subtitles',
      issueOther: 'Other',
      issueMessage: 'Describe the problem',
      issueEpisodeHint: 'Reported for S{s}E{e}',
      issueSent: 'Thanks, your report was sent',
      requestSubtitles: 'Request subtitles',
      requestAudio: 'Request audio language',
      language: 'Language',
      languageSeason: 'Season (optional)',
      wholeSeries: 'Whole series',
      languageSent: 'Language request sent',
      notLinked: 'Ask your admin to link your account in Arclight',
      notConfigured: 'Arclight is not configured on this server',
      unreachable: 'Arclight could not be reached',
      genericError: 'Something went wrong ({code})',
      noResults: 'No matching titles in Arclight',
      loading: 'Loading…',
      fourK: '4K',
      year: '{year}',
      accountDisabled: 'Your Jellyfin account is disabled in Arclight',
      contentRestricted: 'This title is not available for your account',
      blockedPermissionMovie: "Your account can't request movies",
      blockedPermissionSeries: "Your account can't request series",
      blockedRequestTypeMovie: 'Movie requests are turned off for your account',
      blockedRequestTypeSeries: 'Series requests are turned off for your account',
      blockedQuota: 'You have reached your request limit',
      blockedContent: 'Not available for your account',
      blockedAvailable: 'Already in the library',
      blockedRequested: 'Already requested',
      futureSeasons: 'Also future seasons',
      alsoSubtitles: 'Also request subtitles',
      alsoAudio: 'Also request an audio language',
      alsoOn: 'Also on',
      rent: 'Rent',
      buy: 'Buy',
      justWatch: 'Data from JustWatch',
      discover: 'Discover',
      myRequests: 'My requests',
      comingSoon: 'Coming soon',
      trending: 'Trending',
      popularMovies: 'Popular movies',
      popularSeries: 'Popular series',
      upcomingMovies: 'Upcoming movies',
      upcomingSeries: 'Upcoming series',
      nothingHere: 'Nothing to show',
      loadMore: 'Load more',
      cancelRequest: 'Cancel request',
      requestCancelled: 'Request cancelled',
      statusPending: 'Pending approval',
      statusApproved: 'Approved',
      statusDeclined: 'Declined',
      statusFailed: 'Failed',
      statusCompleted: 'Completed',
      statusAvailable: 'Available',
      statusProcessing: 'Processing',
      subtitleIn: 'Subtitles: {lang}',
      audioIn: 'Audio: {lang}',
      episodeCode: 'S{s} E{e}',
      releaseCinema: 'In cinemas',
      releaseDigital: 'Digital',
      releasePhysical: 'Disc',
      theme: 'Theme',
      themeOff: 'Off',
      themeFollow: 'Follow my Arclight theme',
      themeDefault: 'Server default ({name})',
      themeSaved: 'Theme saved',
      close2: 'Close',
      size: '{size}',
      recommended: 'Recommended for you',
      trendingTitle: 'Trending',
      today: 'Today',
      thisWeek: 'This week',
      topRatedMovies: 'Top rated movies',
      topRatedSeries: 'Top rated series',
      nowPlaying: 'In cinemas now',
      airingToday: 'Airing today',
      onTheAir: 'On the air',
      trendingDay: 'Trending today',
      trendingWeek: 'Trending this week',
      seeAll: 'See all',
      movieGenres: 'Movie genres',
      seriesGenres: 'Series genres',
      movies: 'Movies',
      series: 'Series',
      sortBy: 'Sort by',
      sortPopularity: 'Popularity',
      sortRating: 'Rating',
      sortReleaseDate: 'Release date',
      sortTitle: 'Title',
      cast: 'Cast',
      directedBy: 'Director',
      createdBy: 'Created by',
      networks: 'Networks',
      studios: 'Studios',
      releaseDates: 'Release',
      inCinemas: 'Cinemas {date}',
      digitalRelease: 'Digital {date}',
      physicalRelease: 'Disc {date}',
      firstAired: 'First aired {date}',
      lastAired: 'Last aired {date}',
      seasonsHeading: 'Seasons',
      episodes: '{n} episodes',
      moreLikeThis: 'More like this',
      trailer: 'Trailer',
      openInJellyfin: 'Open in Jellyfin',
      viewInArclight: 'View in Arclight',
      reportNeedsLibrary: 'Available once the title is in the library',
      runtime: '{n} min',
      score: '★ {n}',
      stats: 'Stats',
      myStats: 'My stats',
      serverStats: 'Server stats',
      yearInReview: 'Year in review',
      lastDays: 'Last {n} days',
      allTime: 'All time',
      period: 'Period',
      plays: 'Plays',
      watchTime: 'Watch time',
      titlesWatched: 'Titles',
      moviesWatched: 'Movies',
      episodesWatched: 'Episodes',
      seriesWatched: 'Series',
      viewers: 'Viewers',
      activeDays: 'Active days',
      playMethods: 'How it played',
      directPlay: 'Direct play',
      directStream: 'Direct stream',
      transcode: 'Transcode',
      unknownMethod: 'Unknown',
      topMovies: 'Top movies',
      topSeries: 'Top series',
      topGenres: 'Top genres',
      devices: 'Devices',
      clients: 'Apps',
      mostActiveUsers: 'Most active users',
      perDay: 'Watch time per day',
      heatmap: 'When you watch',
      heatmapServer: 'When people watch',
      heatCell: '{day} {hour}:00 · {n} plays',
      dayBar: '{date} · {time}',
      playsAndTime: '{n} plays · {time}',
      durM: '{m}m',
      durHM: '{h}h {m}m',
      durDH: '{d}d {h}h',
      noPlays: 'No plays in this period yet.',
      year: 'Year',
      wrappedTitle: '{name}: {year}',
      noPlaysYear: 'No plays in {year} yet.',
      topDevice: 'Favourite device',
      busiestMonth: 'Busiest month',
      favouriteDay: 'Favourite day',
      favouriteHour: 'Favourite hour',
      longestDay: 'Longest day',
      longestDayValue: '{date} · {time}',
      firstPlay: 'First play',
      firstPlayValue: '{title} · {date}',
      percentile: 'Watched more than {n}% of viewers',
      perMonth: 'Watch time per month',
      shareCard: 'Your card',
      downloadImage: 'Download image',
      createShareLink: 'Create share link',
      shareLinkCreated: 'Share link created',
      shareLinkExpires: 'Expires {date}',
      shareLinkPath: 'Arclight has no public address set, so this link is relative to your Arclight server:',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Could not copy; select the link and copy it yourself',
      leavingSoon: 'Leaving Soon',
      leavesOn: 'Leaves {date}',
      statsOff: 'This is turned off in Arclight.'
    }
  };

  function pickLocale() {
    var langs = [document.documentElement.lang, navigator.language].concat(navigator.languages || []);
    for (var i = 0; i < langs.length; i++) {
      var l = (langs[i] || '').toLowerCase();
      if (STRINGS[l]) return l;
      var base = l.split('-')[0];
      if (STRINGS[base]) return base;
    }
    return 'en';
  }

  var locale = pickLocale();

  function t(key, vars) {
    var s = (STRINGS[locale] && STRINGS[locale][key]) || STRINGS.en[key] || key;
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, function (m, k) {
        return vars[k] === undefined || vars[k] === null ? m : String(vars[k]);
      });
    }
    return s;
  }

  // ------------------------------------------------------------------ helpers
  // url-guard:start (tests/web/url-guard.test.mjs runs this block)
  // Links and images built from server data (TMDB, JustWatch, trailers) may only point at http(s)
  // addresses, relative or fragment links, or blob: URLs this script makes itself. A javascript: or
  // data: URL from poisoned metadata is dropped: the element renders without the attribute.
  function isHttpUrl(v) {
    if (typeof v !== 'string' || !v) return false;
    try {
      var u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  function safeUrl(v) {
    var s = String(v);
    try {
      return /^(https?|blob):$/.test(new URL(s, location.href).protocol) ? s : null;
    } catch (e) {
      return null;
    }
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'href' || k === 'src') {
          var safe = safeUrl(v);
          if (safe !== null) node.setAttribute(k, safe);
        } else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  // url-guard:end

  function debounce(fn, ms) {
    var timer = null;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  function formatEta(seconds) {
    seconds = Math.max(0, Math.round(seconds));
    if (seconds < 60) return seconds + 's';
    var m = Math.round(seconds / 60);
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    var rest = m % 60;
    if (h < 48) return rest ? h + 'h ' + rest + 'm' : h + 'h';
    return Math.round(h / 24) + 'd';
  }

  function formatDate(iso) {
    // A bare date ("2027-03-18") is a calendar day, not midnight UTC: build it in local time so it
    // does not show as the previous day west of Greenwich.
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    var d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    try {
      return d.toLocaleDateString(document.documentElement.lang || undefined, opts);
    } catch (e) {
      return d.toDateString();
    }
  }

  function percent(progress) {
    // Arclight sends download progress as a fraction from 0 to 1.
    var p = (Number(progress) || 0) * 100;
    return Math.max(0, Math.min(100, Math.round(p)));
  }

  function personName(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    return v.displayName || v.name || v.username || v.userName || '';
  }

  function hashParams() {
    var h = window.location.hash || '';
    var q = h.indexOf('?');
    var path = (q >= 0 ? h.slice(0, q) : h).replace(/^#!?/, '');
    var params = new URLSearchParams(q >= 0 ? h.slice(q + 1) : window.location.search);
    return { path: path.toLowerCase(), params: params };
  }

  // ------------------------------------------------------------------ API
  function apiClient() {
    return window.ApiClient;
  }

  function authHeader() {
    var c = apiClient();
    var token = c && c.accessToken && c.accessToken();
    if (!token) return null;
    var parts = ['Token="' + token + '"'];
    try {
      if (c.appName) parts.push('Client="' + encodeURIComponent(c.appName()) + '"');
      if (c.deviceName) parts.push('Device="' + encodeURIComponent(c.deviceName()) + '"');
      if (c.deviceId) parts.push('DeviceId="' + encodeURIComponent(c.deviceId()) + '"');
      if (c.appVersion) parts.push('Version="' + encodeURIComponent(c.appVersion()) + '"');
    } catch (e) { /* token alone is enough */ }
    return 'MediaBrowser ' + parts.join(', ');
  }

  function url(path) {
    var c = apiClient();
    return c.getUrl('Arclight/' + path);
  }

  function call(method, path, body) {
    var headers = { Accept: 'application/json' };
    var auth = authHeader();
    if (!auth) return Promise.reject({ status: 401, code: 'not_signed_in' });
    headers.Authorization = auth;
    var init = { method: method, headers: headers, credentials: 'same-origin' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(url(path), init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          throw { status: res.status, code: (data && data.code) || 'http_' + res.status, data: data };
        }
        return data;
      });
    });
  }

  function errorMessage(err) {
    var code = (err && err.code) || 'error';
    if (code === 'not_linked') return t('notLinked');
    if (code === 'account_disabled') return t('accountDisabled');
    if (code === 'content_restricted') return t('contentRestricted');
    if (code === 'not_configured') return t('notConfigured');
    if (code === 'arclight_unreachable' || code === 'arclight_timeout') return t('unreachable');
    var text = err && err.data && (err.data.error || err.data.message);
    if (typeof text === 'string' && text.length < 200) return text;
    return t('genericError', { code: code });
  }

  // ------------------------------------------------------------------ toast + dialog
  function toast(message, isError) {
    var host = document.querySelector('.arclight-toasts');
    if (!host) {
      host = el('div', { class: 'arclight-toasts', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(host);
    }
    var node = el('div', { class: 'arclight-toast' + (isError ? ' arclight-toast-error' : ''), text: message });
    host.appendChild(node);
    setTimeout(function () { node.classList.add('arclight-toast-hide'); }, 3600);
    setTimeout(function () { node.remove(); }, 4200);
  }

  function dialog(title, body, actions) {
    var previous = document.activeElement;
    var backdrop = el('div', { class: 'arclight-backdrop' });
    var panel = el('div', { class: 'arclight-dialog dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    function close() {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      if (previous && previous.focus) previous.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    }
    var footer = el('div', { class: 'arclight-dialog-actions' });
    (actions || []).forEach(function (a) {
      var b = el('button', {
        type: 'button',
        class: 'emby-button arclight-btn' + (a.primary ? ' raised button-submit' : ' button-flat arclight-btn-secondary'),
        text: a.label,
        onclick: function () {
          if (a.onClick) {
            var r = a.onClick(close, b);
            if (r === false) return;
          } else {
            close();
          }
        }
      });
      footer.appendChild(b);
    });
    panel.appendChild(el('h2', { class: 'arclight-dialog-title', text: title }));
    panel.appendChild(el('div', { class: 'arclight-dialog-body' }, [body]));
    panel.appendChild(footer);
    backdrop.appendChild(panel);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    var first = panel.querySelector('input, select, textarea, button');
    if (first) first.focus();
    return { close: close, panel: panel };
  }

  function busy(button, on) {
    if (!button) return;
    button.disabled = !!on;
    button.classList.toggle('arclight-busy', !!on);
  }

  // ------------------------------------------------------------------ state
  var state = {
    config: null,
    userId: null,
    watchlist: null,
    watchlistAt: 0,
    detailsToken: 0,
    searchToken: 0,
    lastQuery: null,
    linked: true,
    access: null
  };

  function features() {
    return (state.config && state.config.configured && state.config.features) || {};
  }

  function loadConfig() {
    var c = apiClient();
    var uid = c && c.getCurrentUserId && c.getCurrentUserId();
    if (!uid) return Promise.resolve(null);
    if (state.config && state.userId === uid) return Promise.resolve(state.config);
    state.userId = uid;
    state.watchlist = null;
    state.linked = true;
    themeState.loaded = false;
    state.access = null;
    return call('GET', 'ClientConfig').then(function (cfg) {
      state.config = cfg;
      return loadAccess().then(function () { return cfg; });
    }, function () {
      state.config = null;
      return null;
    });
  }

  /** Whether the connected Arclight advertises a feature in its ping (older releases have no stats). */
  function arclightHas(name) {
    var list = state.config && state.config.arclightFeatures;
    return Array.isArray(list) && list.indexOf(name) >= 0;
  }

  /** What this user may see: the plugin toggles AND Arclight's features AND Arclight's per-user answer. */
  function statsAccess() {
    var f = features();
    var a = state.access || {};
    return {
      myStats: !!f.myStats && arclightHas('stats') && a.myStats === true,
      serverStats: !!f.serverStats && arclightHas('stats') && a.serverStats === true,
      wrapped: !!f.wrapped && arclightHas('wrapped') && a.wrapped === true,
      shareLinks: !!f.wrapped && arclightHas('wrapped') && a.wrapped === true && a.shareLinks === true,
      leavingSoon: !!f.leavingSoon && arclightHas('leavingSoon') && a.leavingSoon === true
    };
  }

  function loadAccess() {
    var f = features();
    var wanted = ((f.myStats || f.serverStats) && arclightHas('stats')) || (f.wrapped && arclightHas('wrapped')) || (f.leavingSoon && arclightHas('leavingSoon'));
    if (!wanted) return Promise.resolve(null);
    return call('GET', 'Stats/Access').then(function (a) {
      state.access = a && typeof a === 'object' ? a : null;
      return state.access;
    }, function () {
      state.access = null;
      return null;
    });
  }

  function loadWatchlist(force) {
    if (!force && state.watchlist && Date.now() - state.watchlistAt < 60000) return Promise.resolve(state.watchlist);
    return call('GET', 'Watchlist').then(function (data) {
      var list = Array.isArray(data) ? data : (data && (data.items || data.results)) || [];
      var set = {};
      list.forEach(function (w) { if (w && w.tmdbId) set[w.mediaType + ':' + w.tmdbId] = true; });
      state.watchlist = set;
      state.watchlistAt = Date.now();
      return set;
    });
  }

  // ------------------------------------------------------------------ navigation
  function pageHref(name, params) {
    var q = new URLSearchParams();
    q.set('arclight', name);
    Object.keys(params || {}).forEach(function (k) { if (params[k] !== undefined && params[k] !== null && params[k] !== '') q.set(k, params[k]); });
    return '#/home?' + q.toString();
  }

  /** Library titles open Jellyfin's own page; everything else opens the Arclight title page. */
  function titleHref(mediaType, tmdbId, jellyfinId) {
    if (jellyfinId) return '#/details?id=' + jellyfinId;
    return pageHref('title', { type: mediaType, id: tmdbId });
  }

  // ------------------------------------------------------------------ request rules
  function blockedText(reason, mediaType) {
    var series = mediaType === 'series';
    switch (reason) {
      case 'permission': return t(series ? 'blockedPermissionSeries' : 'blockedPermissionMovie');
      case 'request_type': return t(series ? 'blockedRequestTypeSeries' : 'blockedRequestTypeMovie');
      case 'quota': return t('blockedQuota');
      case 'content_restricted': return t('blockedContent');
      case 'available': return t('blockedAvailable');
      case 'requested': return t('blockedRequested');
      default: return '';
    }
  }

  // ------------------------------------------------------------------ request dialog
  function seasonLabel(n) {
    return Number(n) === 0 ? t('specials') : t('season', { n: n });
  }

  function openRequestDialog(target, onDone) {
    // target: { mediaType, tmdbId, title, canRequest4k, preselectMissing }
    var body = el('div', { class: 'arclight-form' }, [el('div', { class: 'arclight-muted', text: t('loading') })]);
    var seasonBoxes = [];
    var allBox = null;
    var fourK = null;
    var profile = null;
    var future = null;
    var subLang = null;
    var audioLang = null;
    var blocked = false;
    var d = dialog(t('requestTitle', { title: target.title || '' }), body, [
      { label: t('cancel') },
      {
        label: t('submit'),
        primary: true,
        onClick: function (close, button) {
          if (blocked) { close(); return false; }
          var payload = { mediaType: target.mediaType, tmdbId: target.tmdbId };
          if (target.mediaType === 'series') {
            if (allBox && allBox.checked) {
              payload.seasons = 'all';
            } else if (seasonBoxes.length) {
              var picked = seasonBoxes.filter(function (b) { return b.checked && !b.disabled; }).map(function (b) { return Number(b.value); });
              if (!picked.length) return false;
              payload.seasons = picked;
            } else {
              payload.seasons = 'all';
            }
          }
          if (fourK && fourK.checked) payload.is4k = true;
          if (profile && profile.value) payload.qualityProfileId = Number(profile.value);
          if (future && future.checked) payload.seasons = 'all';
          busy(button, true);
          call('POST', 'Request', payload).then(function (res) {
            close();
            // 201: the request; 202: { message } when Arclight queued it for later processing.
            toast(res && typeof res.message === 'string' && !res.id ? res.message : t('requestSent', { title: target.title || '' }));
            [['subtitle', subLang], ['audio', audioLang]].forEach(function (pair) {
              var sel = pair[1];
              if (!sel || !sel.box.checked || !sel.select.value) return;
              call('POST', 'LanguageRequest', { kind: pair[0], mediaType: target.mediaType, tmdbId: target.tmdbId, language: sel.select.value })
                .then(function () { toast(t('languageSent')); }, function (err) { toast(errorMessage(err), true); });
            });
            if (onDone) onDone();
          }, function (err) {
            busy(button, false);
            toast(errorMessage(err), true);
          });
          return false;
        }
      }
    ]);

    var titleInfo = call('GET', 'Title/' + target.mediaType + '/' + target.tmdbId).catch(function (err) {
      if (err && err.code === 'not_linked') throw err;
      return null; // still allow a plain request
    });

    titleInfo.then(function (info) {
      body.textContent = '';
      if (info && info.canRequest === false && info.requestBlockedReason) {
        blocked = true;
        body.appendChild(el('p', { class: 'arclight-blocked', text: blockedText(info.requestBlockedReason, target.mediaType) }));
        var submit = d.panel.querySelector('.button-submit');
        if (submit) submit.textContent = t('close2');
        appendProviders(body, target.mediaType, target.tmdbId);
        return;
      }
      var can4k = info ? !!info.canRequest4k : target.canRequest4k;
      if (target.mediaType === 'series') {
        var seasons = (info && Array.isArray(info.seasons)) ? info.seasons : [];
        if (seasons.length) {
          body.appendChild(el('div', { class: 'arclight-label', text: t('seasons') }));
          allBox = el('input', { type: 'checkbox', class: 'arclight-check' });
          body.appendChild(el('label', { class: 'arclight-row arclight-row-strong' }, [allBox, el('span', { text: t('allSeasons') })]));
          var list = el('div', { class: 'arclight-seasons' });
          seasons.forEach(function (s) {
            var n = s.seasonNumber !== undefined ? s.seasonNumber : s.number;
            if (n === undefined || n === null) return;
            var status = s.status || 'none';
            var done = status === 'available' || status === 'requested' || status === 'processing';
            var box = el('input', { type: 'checkbox', class: 'arclight-check', value: String(n) });
            box.checked = done || (!!target.preselectMissing && status !== 'available');
            box.disabled = done;
            seasonBoxes.push(box);
            list.appendChild(el('label', { class: 'arclight-row' + (done ? ' arclight-row-done' : '') }, [
              box,
              el('span', { text: seasonLabel(n) }),
              status !== 'none' ? el('span', { class: 'arclight-chip arclight-chip-' + status, text: t(status) }) : null
            ]));
          });
          allBox.addEventListener('change', function () {
            seasonBoxes.forEach(function (b) { if (!b.disabled) b.checked = allBox.checked; });
          });
          body.appendChild(list);
        }
      }
      if (can4k) {
        fourK = el('input', { type: 'checkbox', class: 'arclight-check' });
        body.appendChild(el('label', { class: 'arclight-row arclight-row-strong' }, [fourK, el('span', { text: t('request4k') })]));
      }
      var profiles = (info && info.canRequestAdvanced !== false && Array.isArray(info.qualityProfiles)) ? info.qualityProfiles : [];
      if (profiles.length) {
        profile = el('select', { class: 'arclight-input emby-select' }, [el('option', { value: '', text: t('defaultProfile') })].concat(
          profiles.map(function (p) { return el('option', { value: String(p.id), text: p.name }); })));
        body.appendChild(el('label', { class: 'arclight-label', text: t('qualityProfile') }));
        body.appendChild(profile);
      }
      if (target.mediaType === 'series' && info && info.canRequestFutureSeasons) {
        future = el('input', { type: 'checkbox', class: 'arclight-check' });
        body.appendChild(el('label', { class: 'arclight-row arclight-row-strong' }, [future, el('span', { text: t('futureSeasons') })]));
      }
      var langs = languageOptions(info);
      function langPicker(label) {
        var box = el('input', { type: 'checkbox', class: 'arclight-check' });
        var select = el('select', { class: 'arclight-input emby-select', disabled: true }, langs.map(function (o) { return el('option', { value: o.value, text: o.label }); }));
        box.addEventListener('change', function () { select.disabled = !box.checked; });
        body.appendChild(el('label', { class: 'arclight-row arclight-row-strong' }, [box, el('span', { text: label })]));
        body.appendChild(select);
        return { box: box, select: select };
      }
      if (features().languageRequests && langs.length) {
        if (info.canRequestSubtitles) subLang = langPicker(t('alsoSubtitles'));
        if (info.canRequestAudio) audioLang = langPicker(t('alsoAudio'));
      }
      if (!body.childNodes.length) {
        body.appendChild(el('p', { text: target.title || '' }));
      }
      appendProviders(body, target.mediaType, target.tmdbId);
    }, function (err) {
      d.close();
      toast(errorMessage(err), true);
    });
  }

  // ------------------------------------------------------------------ issue + language dialogs
  function openIssueDialog(info) {
    var type = el('select', { class: 'arclight-input emby-select' }, [
      el('option', { value: 'video', text: t('issueVideo') }),
      el('option', { value: 'audio', text: t('issueAudio') }),
      el('option', { value: 'subtitles', text: t('issueSubtitles') }),
      el('option', { value: 'other', text: t('issueOther') })
    ]);
    var message = el('textarea', { class: 'arclight-input arclight-textarea', rows: '4', maxlength: '5000' });
    var children = [
      el('label', { class: 'arclight-label', text: t('issueType') }), type,
      el('label', { class: 'arclight-label', text: t('issueMessage') }), message
    ];
    if (info.episodeNumber !== null && info.episodeNumber !== undefined && info.seasonNumber !== null && info.seasonNumber !== undefined) {
      children.push(el('div', { class: 'arclight-muted', text: t('issueEpisodeHint', { s: info.seasonNumber, e: info.episodeNumber }) }));
    }
    dialog(t('reportProblem'), el('div', { class: 'arclight-form' }, children), [
      { label: t('cancel') },
      {
        label: t('submit'),
        primary: true,
        onClick: function (close, button) {
          var text = message.value.trim();
          if (!text) { message.focus(); return false; }
          var payload = { mediaType: info.mediaType, tmdbId: info.tmdbId, type: type.value, message: text };
          if (info.mediaType === 'series' && info.seasonNumber !== null && info.seasonNumber !== undefined) {
            payload.seasonNumber = info.seasonNumber;
            if (info.episodeNumber !== null && info.episodeNumber !== undefined) payload.episodeNumber = info.episodeNumber;
          }
          busy(button, true);
          call('POST', 'Issue', payload).then(function () {
            close();
            toast(t('issueSent'));
          }, function (err) {
            busy(button, false);
            toast(errorMessage(err), true);
          });
          return false;
        }
      }
    ]);
  }

  function languageOptions(title) {
    var raw = (title && (title.languages || title.languageOptions)) || [];
    return raw.map(function (l) {
      if (typeof l === 'string') return { value: l, label: l };
      var value = l.code || l.value || l.id || l.name;
      return value ? { value: value, label: l.name || l.label || value } : null;
    }).filter(Boolean);
  }

  function openLanguageDialog(kind, info, title) {
    var opts = languageOptions(title);
    var lang = opts.length
      ? el('select', { class: 'arclight-input emby-select' }, opts.map(function (o) { return el('option', { value: o.value, text: o.label }); }))
      : el('input', { class: 'arclight-input', type: 'text', maxlength: '64', placeholder: 'en, es, Japanese…' });
    var children = [el('label', { class: 'arclight-label', text: t('language') }), lang];
    var seasonSel = null;
    if (info.mediaType === 'series') {
      var seasons = (title && Array.isArray(title.seasons)) ? title.seasons : [];
      seasonSel = el('select', { class: 'arclight-input emby-select' }, [el('option', { value: '', text: t('wholeSeries') })].concat(
        seasons.map(function (s) {
          var n = s.seasonNumber !== undefined ? s.seasonNumber : s.number;
          return el('option', { value: String(n), text: seasonLabel(n) });
        })));
      if (info.seasonNumber !== null && info.seasonNumber !== undefined) seasonSel.value = String(info.seasonNumber);
      children.push(el('label', { class: 'arclight-label', text: t('languageSeason') }), seasonSel);
    }
    dialog(kind === 'subtitle' ? t('requestSubtitles') : t('requestAudio'), el('div', { class: 'arclight-form' }, children), [
      { label: t('cancel') },
      {
        label: t('submit'),
        primary: true,
        onClick: function (close, button) {
          var value = (lang.value || '').trim();
          if (value.length < 2) { lang.focus(); return false; }
          var payload = { kind: kind, mediaType: info.mediaType, tmdbId: info.tmdbId, language: value };
          if (seasonSel && seasonSel.value !== '') payload.seasonNumber = Number(seasonSel.value);
          busy(button, true);
          call('POST', 'LanguageRequest', payload).then(function () {
            close();
            toast(t('languageSent'));
          }, function (err) {
            busy(button, false);
            toast(errorMessage(err), true);
          });
          return false;
        }
      }
    ]);
  }

  // ------------------------------------------------------------------ item page
  function visiblePage(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var nodes = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < nodes.length; j++) {
        if (!nodes[j].classList.contains('hide') && nodes[j].offsetParent !== null) return nodes[j];
      }
    }
    return null;
  }

  // Where the bar goes: first thing in the right-hand details column (beside the poster), else on
  // its own row after the ribbon holding the play/favourite buttons.
  function placeBar(page, bar) {
    var column = page.querySelector('.detailPagePrimaryContent .detailSection');
    if (column) {
      column.insertBefore(bar, column.firstChild);
      return true;
    }
    var candidates = ['.detailPagePrimaryContainer .detailRibbon', '.detailRibbon', '.mainDetailButtons', '.itemMiscInfo-primary'];
    for (var i = 0; i < candidates.length; i++) {
      var n = page.querySelector(candidates[i]);
      if (n && n.parentNode) {
        bar.classList.add('padded-left', 'padded-right');
        n.parentNode.insertBefore(bar, n.nextSibling);
        return true;
      }
    }
    return false;
  }

  function chip(text, kind) {
    return el('span', { class: 'arclight-chip' + (kind ? ' arclight-chip-' + kind : ''), text: text });
  }

  function actionButton(label, icon, onClick, pressed) {
    return el('button', {
      type: 'button',
      class: 'emby-button arclight-action' + (pressed ? ' arclight-action-on' : ''),
      title: label,
      'aria-pressed': pressed === undefined ? null : String(!!pressed),
      onclick: onClick
    }, [el('span', { class: 'material-icons arclight-icon', 'aria-hidden': 'true', text: icon }), el('span', { class: 'arclight-action-label', text: label })]);
  }

  function statusChips(status, info, bar, refresh) {
    var f = features();
    var chips = [];
    if (!status) return chips;
    if (status.request) {
      var r = status.request;
      var who = personName(r.requestedBy);
      if (who) {
        chips.push(chip(t(String(r.status).toLowerCase() === 'pending' ? 'requestedPending' : 'requestedBy', { name: who }) + (r.is4k ? ' · ' + t('fourK') : ''), 'requested'));
      } else {
        chips.push(chip(t('requested') + (r.is4k ? ' · ' + t('fourK') : ''), 'requested'));
      }
    }
    if (status.download) {
      var dl = status.download;
      var st = String(dl.status || 'downloading').toLowerCase();
      var pct = percent(dl.progress);
      var text;
      if (st === 'queued') text = t('downloadQueued');
      else if (st === 'paused') text = t('downloadPaused');
      else if (st === 'importing') text = t('importing');
      else if (dl.etaSeconds !== undefined && dl.etaSeconds !== null) text = t('downloadingEta', { pct: pct, eta: formatEta(dl.etaSeconds) });
      else text = t('downloading', { pct: pct });
      var c = chip(text, 'processing');
      c.style.setProperty('--arclight-progress', pct + '%');
      c.classList.add('arclight-chip-progress');
      chips.push(c);
    }
    if (status.upcoming && status.upcoming.releaseDate) {
      chips.push(chip(t('comingOn', { date: formatDate(status.upcoming.releaseDate) }), 'upcoming'));
    }
    var missing = Number(status.missingEpisodes) || 0;
    if (missing > 0) {
      chips.push(chip(missing === 1 ? t('missingEpisode') : t('missingEpisodes', { n: missing }), 'missing'));
      if (f.requests && info.mediaType === 'series' && info.tmdbId && (info.type === 'Series' || info.type === 'Season')) {
        chips.push(el('button', {
          type: 'button',
          class: 'emby-button raised button-submit arclight-chip-button',
          text: t('requestMissing'),
          onclick: function () {
            openRequestDialog({ mediaType: 'series', tmdbId: info.tmdbId, title: info.name, preselectMissing: true }, refresh);
          }
        }));
      }
    }
    if (status.monitored === false && status.inLibrary) {
      chips.push(chip(t('notMonitored'), 'muted'));
    }
    return chips;
  }

  function renderDetails(itemId) {
    var f = features();
    if (!(f.badges || f.watchlist || f.issues || f.languageRequests || f.providers || f.labels)) return;
    var page = visiblePage(['#itemDetailPage', '.itemDetailPage', '.page.libraryPage[data-type="details"]']);
    if (!page) return;
    var existing = page.querySelector('.arclight-bar');
    if (existing && existing.getAttribute('data-item') === itemId) return;
    if (existing) existing.remove();

    var bar = el('div', { class: 'arclight-bar', 'data-item': itemId });
    if (!placeBar(page, bar)) return;
    var token = ++state.detailsToken;

    function refresh() {
      call('GET', 'Item/' + encodeURIComponent(itemId)).then(function (data) {
        if (token !== state.detailsToken || !bar.isConnected) return;
        fill(data);
      }, function (err) {
        if (token !== state.detailsToken || !bar.isConnected) return;
        bar.textContent = '';
        if (err && (err.code === 'not_linked' || err.code === 'account_disabled')) {
          state.linked = false;
          bar.appendChild(chip(errorMessage(err), 'muted'));
        }
        if (features().labels) appendItemLabels(bar, itemId);
        // other errors: stay quiet on item pages
      });
    }

    function fill(data) {
      bar.textContent = '';
      var info = (data && data.item) || {};
      var chipsRow = el('div', { class: 'arclight-chips' });
      if (f.badges) statusChips(data && data.status, info, bar, refresh).forEach(function (c) { chipsRow.appendChild(c); });
      if (chipsRow.childNodes.length) bar.appendChild(chipsRow);
      if (features().labels && (info.type === 'Movie' || info.type === 'Episode')) appendItemLabels(bar, itemId);
      if (!info.mediaType || !info.tmdbId) return;
      if (info.type === 'Movie' || info.type === 'Series') appendProviders(bar, info.mediaType, info.tmdbId);

      var actions = el('div', { class: 'arclight-actions' });
      bar.appendChild(actions);
      var key = info.mediaType + ':' + info.tmdbId;
      var isTitleLevel = info.type === 'Movie' || info.type === 'Series';

      if (f.watchlist && isTitleLevel) {
        loadWatchlist(false).then(function (set) {
          if (!bar.isConnected) return;
          var on = !!set[key];
          var btn = actionButton(on ? t('watchlistRemove') : t('watchlistAdd'), on ? 'bookmark' : 'bookmark_border', function () {
            busy(btn, true);
            var req = on
              ? call('DELETE', 'Watchlist?mediaType=' + info.mediaType + '&tmdbId=' + info.tmdbId)
              : call('POST', 'Watchlist', { mediaType: info.mediaType, tmdbId: info.tmdbId });
            req.then(function () {
              on = !on;
              if (on) set[key] = true; else delete set[key];
              toast(on ? t('watchlistAdded') : t('watchlistRemoved'));
              btn.querySelector('.arclight-icon').textContent = on ? 'bookmark' : 'bookmark_border';
              btn.querySelector('.arclight-action-label').textContent = on ? t('watchlistRemove') : t('watchlistAdd');
              btn.title = on ? t('watchlistRemove') : t('watchlistAdd');
              btn.classList.toggle('arclight-action-on', on);
              btn.setAttribute('aria-pressed', String(on));
            }, function (err) { toast(errorMessage(err), true); }).then(function () { busy(btn, false); });
          }, on);
          actions.insertBefore(btn, actions.firstChild);
        }, function () { /* watchlist unavailable */ });
      }

      if (f.issues) {
        actions.appendChild(actionButton(t('reportProblem'), 'report_problem', function () { openIssueDialog(info); }));
      }

      if (isTitleLevel && f.discover) {
        // The Arclight title page: cast, recommendations, request status in one place.
        actions.appendChild(el('a', { class: 'emby-button arclight-action', href: pageHref('title', { type: info.mediaType, id: info.tmdbId }) }, [
          el('span', { class: 'material-icons arclight-icon', 'aria-hidden': 'true', text: 'open_in_new' }),
          el('span', { class: 'arclight-action-label', text: t('viewInArclight') })
        ]));
      }

      if (f.languageRequests) {
        call('GET', 'Title/' + info.mediaType + '/' + info.tmdbId).then(function (title) {
          if (!bar.isConnected || !title) return;
          if (title.canRequestSubtitles) {
            actions.appendChild(actionButton(t('requestSubtitles'), 'subtitles', function () { openLanguageDialog('subtitle', info, title); }));
          }
          if (title.canRequestAudio) {
            actions.appendChild(actionButton(t('requestAudio'), 'record_voice_over', function () { openLanguageDialog('audio', info, title); }));
          }
        }, function () { /* not allowed or not linked */ });
      }
    }

    refresh();
  }

  // ------------------------------------------------------------------ search
  function statusLabel(status) {
    switch (status) {
      case 'available': return t('available');
      case 'partial': return t('partial');
      case 'requested': return t('requested');
      case 'processing': return t('processing');
      default: return '';
    }
  }

  function resultCard(r) {
    var poster = r.posterUrl
      ? el('img', { class: 'arclight-poster-img', src: r.posterUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : el('div', { class: 'arclight-poster-empty material-icons', 'aria-hidden': 'true', text: r.mediaType === 'series' ? 'tv' : 'movie' });
    var label = statusLabel(r.status);
    var footer = el('div', { class: 'arclight-card-footer' });
    var href = r.tmdbId ? titleHref(r.mediaType, r.tmdbId, r.jellyfinId) : null;
    var card = el('div', { class: 'arclight-card', title: r.overview || '' }, [
      el(href ? 'a' : 'div', { class: 'arclight-poster arclight-card-link', href: href }, [poster, label ? el('span', { class: 'arclight-chip arclight-chip-' + r.status + ' arclight-poster-chip', text: label }) : null]),
      el(href ? 'a' : 'div', { class: 'arclight-card-title arclight-card-link', href: href, text: r.title || '' }),
      el('div', { class: 'arclight-card-meta', text: r.year ? String(r.year) : '' }),
      footer
    ]);
    if (features().requests && !r.canRequest && r.requestBlockedReason && r.requestBlockedReason !== 'available' && r.requestBlockedReason !== 'requested') {
      footer.appendChild(el('div', { class: 'arclight-blocked arclight-card-reason', text: blockedText(r.requestBlockedReason, r.mediaType) }));
    }
    if (features().requests && r.canRequest && (r.status === 'none' || r.status === 'partial' || !r.status)) {
      footer.appendChild(el('button', {
        type: 'button',
        class: 'emby-button raised button-submit arclight-card-btn',
        text: t('request'),
        onclick: function (e) {
          e.stopPropagation();
          openRequestDialog({ mediaType: r.mediaType, tmdbId: r.tmdbId, title: r.title, canRequest4k: r.canRequest4k }, function () {
            var chipNode = card.querySelector('.arclight-poster-chip');
            if (chipNode) chipNode.remove();
            card.querySelector('.arclight-poster').appendChild(el('span', { class: 'arclight-chip arclight-chip-requested arclight-poster-chip', text: t('requested') }));
            footer.textContent = '';
          });
        }
      }));
    }
    return card;
  }

  function currentSearchQuery(page) {
    var hp = hashParams();
    var q = hp.params.get('query') || hp.params.get('searchTerm') || '';
    var input = page.querySelector('input[type="search"], .searchfields input, input.searchfields-txtSearch');
    if (input && input.value) q = input.value;
    return q.trim();
  }

  var runSearch = debounce(function (page, query) {
    var section = page.querySelector('.arclight-search');
    if (!section) return;
    var grid = section.querySelector('.arclight-grid');
    var token = ++state.searchToken;
    if (!query) {
      section.classList.add('hide');
      return;
    }
    call('GET', 'Search?q=' + encodeURIComponent(query) + '&type=all&page=1').then(function (data) {
      if (token !== state.searchToken || !section.isConnected) return;
      var results = ((data && data.results) || []).filter(function (r) { return r && r.status !== 'available'; });
      grid.textContent = '';
      section.classList.toggle('hide', results.length === 0);
      results.slice(0, 40).forEach(function (r) { grid.appendChild(resultCard(r)); });
    }, function (err) {
      if (token !== state.searchToken || !section.isConnected) return;
      grid.textContent = '';
      if (err && (err.code === 'not_linked' || err.code === 'account_disabled')) {
        section.classList.remove('hide');
        grid.appendChild(el('div', { class: 'arclight-muted', text: errorMessage(err) }));
      } else {
        section.classList.add('hide');
      }
    });
  }, 450);

  function renderSearch() {
    if (!features().search) return;
    var page = visiblePage(['#searchPage', '.searchPage', '.page[data-type="search"]']);
    if (!page) return;
    var section = page.querySelector('.arclight-search');
    if (!section) {
      section = el('div', { class: 'verticalSection arclight-search hide' }, [
        el('div', { class: 'sectionTitleContainer padded-left' }, [
          el('h2', { class: 'sectionTitle arclight-section-title', text: t('sectionTitle') }),
          el('span', { class: 'arclight-muted', text: t('sectionSubtitle') })
        ]),
        el('div', { class: 'arclight-grid padded-left padded-right' })
      ]);
      var results = page.querySelector('.searchResults') || page.querySelector('.searchSuggestions');
      if (results && results.parentNode) results.parentNode.insertBefore(section, results.nextSibling);
      else page.appendChild(section);
      page.addEventListener('input', function (e) {
        if (e.target && e.target.matches && e.target.matches('input')) {
          var q = currentSearchQuery(page);
          if (q !== state.lastQuery) { state.lastQuery = q; runSearch(page, q); }
        }
      });
      state.lastQuery = null;
    } else if (section.parentNode !== page && !page.contains(section)) {
      page.appendChild(section);
    }
    var q = currentSearchQuery(page);
    if (q !== state.lastQuery) {
      state.lastQuery = q;
      runSearch(page, q);
    }
  }

  // ------------------------------------------------------------------ providers ("Also on")
  var providerCache = {};

  function appendProviders(host, mediaType, tmdbId) {
    if (!features().providers || !mediaType || !tmdbId) return;
    var key = mediaType + ':' + tmdbId;
    var box = el('div', { class: 'arclight-providers' });
    host.appendChild(box);
    var p = providerCache[key] || (providerCache[key] = call('GET', 'Providers/' + mediaType + '/' + tmdbId).catch(function () { delete providerCache[key]; return null; }));
    p.then(function (data) {
      if (!data || !box.isConnected) return;
      var groups = [['flatrate', t('alsoOn')], ['rent', t('rent')], ['buy', t('buy')]];
      var any = false;
      groups.forEach(function (g) {
        var list = data[g[0]] || [];
        if (!list.length) return;
        any = true;
        var row = el('div', { class: 'arclight-provider-row' }, [el('span', { class: 'arclight-provider-label', text: g[1] + ':' })]);
        list.slice(0, 8).forEach(function (pr) {
          row.appendChild(el('span', { class: 'arclight-provider', title: pr.name }, [
            pr.logoUrl ? el('img', { src: pr.logoUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
            el('span', { text: pr.name })
          ]));
        });
        box.appendChild(row);
      });
      if (!any) { box.remove(); return; }
      var attribution = isHttpUrl(data.link)
        ? el('a', { class: 'arclight-attribution', href: data.link, target: '_blank', rel: 'noopener noreferrer', text: data.attribution || t('justWatch') })
        : el('span', { class: 'arclight-attribution', text: data.attribution || t('justWatch') });
      box.appendChild(attribution);
    });
  }

  // ------------------------------------------------------------------ quality labels
  var labelCache = {};
  var labelQueue = [];
  var labelWaiters = {};
  var LABEL_TYPES = { Movie: 1, Episode: 1, Video: 1, MusicVideo: 1 };

  function formatSize(bytes) {
    if (!bytes) return '';
    var gb = bytes / 1073741824;
    if (gb >= 1) return gb.toFixed(gb >= 10 ? 0 : 1) + ' GB';
    var mb = bytes / 1048576;
    return mb >= 1 ? Math.round(mb) + ' MB' : '< 1 MB';
  }

  var flushLabels = debounce(function () {
    var ids = labelQueue.splice(0, 100);
    if (labelQueue.length) flushLabels();
    if (!ids.length) return;
    call('GET', 'Labels?ids=' + ids.join(',')).then(function (data) {
      var byId = {};
      ((data && data.items) || []).forEach(function (l) { byId[l.id] = l; });
      ids.forEach(function (id) {
        labelCache[id] = byId[id] || null;
        (labelWaiters[id] || []).forEach(function (cb) { cb(labelCache[id]); });
        delete labelWaiters[id];
      });
    }, function () {
      ids.forEach(function (id) { labelCache[id] = null; delete labelWaiters[id]; });
    });
  }, 250);

  function withLabels(id, cb) {
    if (Object.prototype.hasOwnProperty.call(labelCache, id)) { cb(labelCache[id]); return; }
    if (labelWaiters[id]) { labelWaiters[id].push(cb); return; }
    labelWaiters[id] = [cb];
    labelQueue.push(id);
    flushLabels();
  }

  function cardChips(l) {
    var out = [];
    if (l.resolution) out.push(l.resolution);
    if (l.hdr) out.push(l.hdr);
    if (l.audio && /Atmos|DTS:X/.test(l.audio)) out.push(l.audio.indexOf('Atmos') >= 0 ? 'Atmos' : 'DTS:X');
    else if (l.channels && l.channels !== '2.0' && l.channels !== '1.0') out.push(l.channels);
    return out;
  }

  var labelObserver = null;

  function scanCards() {
    if (!features().labels) return;
    if (!labelObserver && 'IntersectionObserver' in window) {
      labelObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          labelObserver.unobserve(e.target);
          var card = e.target;
          var id = (card.getAttribute('data-id') || '').replace(/-/g, '').toLowerCase();
          withLabels(id, function (l) {
            if (!l || !card.isConnected || card.querySelector('.arclight-labels')) return;
            var chips = cardChips(l);
            if (!chips.length) return;
            var host = card.querySelector('.cardContent') || card.querySelector('.cardScalable');
            if (!host) return;
            host.appendChild(el('div', { class: 'arclight-labels', 'aria-hidden': 'true' }, chips.map(function (c) { return el('span', { text: c }); })));
          });
        });
      }, { rootMargin: '200px' });
    }
    if (!labelObserver) return;
    var cards = document.querySelectorAll('.card[data-id]:not([data-arclight-l])');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      c.setAttribute('data-arclight-l', '1');
      if (LABEL_TYPES[c.getAttribute('data-type')] && /^[0-9a-fA-F-]{32,36}$/.test(c.getAttribute('data-id') || '')) labelObserver.observe(c);
    }
  }

  function appendItemLabels(host, itemId) {
    if (host.querySelector('.arclight-item-labels')) return;
    var row = el('div', { class: 'arclight-chips arclight-item-labels' });
    host.appendChild(row);
    withLabels(itemId, function (l) {
      if (!l || !row.isConnected) { row.remove(); return; }
      var parts = [l.resolution, l.hdr, [l.audio, l.channels].filter(Boolean).join(' '), (l.audioLanguages || []).slice(0, 4).join(' · ').toUpperCase(), formatSize(l.size)].filter(Boolean);
      if (!parts.length) { row.remove(); return; }
      parts.forEach(function (p) { row.appendChild(chip(p, 'label')); });
    });
  }

  // ------------------------------------------------------------------ posters / rows (discover, coming soon)
  function scroller(title, items, extraHeader) {
    var row = el('div', { class: 'arclight-row-scroller' });
    items.forEach(function (n) { row.appendChild(n); });
    return el('div', { class: 'verticalSection arclight-section' }, [
      el('div', { class: 'sectionTitleContainer arclight-section-head' }, [el('h2', { class: 'sectionTitle arclight-section-title', text: title }), extraHeader || null]),
      row
    ]);
  }

  function upcomingCard(u) {
    var poster = u.posterUrl
      ? el('img', { class: 'arclight-poster-img', src: u.posterUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : el('div', { class: 'arclight-poster-empty material-icons', 'aria-hidden': 'true', text: u.mediaType === 'series' ? 'tv' : 'movie' });
    var sub = u.kind === 'episode'
      ? t('episodeCode', { s: u.seasonNumber, e: u.episodeNumber }) + (u.episodeTitle ? ' · ' + u.episodeTitle : '')
      : ({ cinema: t('releaseCinema'), digital: t('releaseDigital'), physical: t('releasePhysical') })[u.releaseType] || '';
    var href = u.tmdbId ? titleHref(u.mediaType, u.tmdbId, u.jellyfinId) : null;
    return el('div', { class: 'arclight-card' }, [
      el(href ? 'a' : 'div', { class: 'arclight-poster arclight-card-link', href: href }, [poster, el('span', { class: 'arclight-chip arclight-chip-upcoming arclight-poster-chip', text: formatDate(u.date) })]),
      el(href ? 'a' : 'div', { class: 'arclight-card-title arclight-card-link', href: href, text: u.title || '' }),
      el('div', { class: 'arclight-card-meta', text: sub })
    ]);
  }

  function loadUpcoming() {
    return call('GET', 'Upcoming?days=30').then(function (d) { return (d && d.items) || []; });
  }

  function renderHomeRow() {
    if (!features().upcoming) return;
    var page = visiblePage(['#indexPage', '.homePage', '.page[data-type="home"]', '.page:not(.hide)']);
    var container = page && page.querySelector('.homeSectionsContainer');
    if (!container || container.querySelector('.arclight-home-upcoming')) return;
    var holder = el('div', { class: 'arclight-home-upcoming padded-left padded-right' });
    var first = container.firstElementChild;
    container.insertBefore(holder, first ? first.nextSibling : null);
    loadUpcoming().then(function (items) {
      if (!holder.isConnected || !items.length) { holder.remove(); return; }
      var link = features().discover ? el('a', { class: 'button-link arclight-section-link', href: '#/home?arclight=discover', text: t('discover') + ' ›' }) : null;
      holder.appendChild(scroller(t('comingSoon'), items.slice(0, 30).map(upcomingCard), link));
    }, function () { holder.remove(); });
  }

  // ------------------------------------------------------------------ Arclight pages (overlay on top of Jellyfin's page)
  var overlay = null;

  function closeOverlay() {
    if (overlay) {
      (overlay.__urls || []).forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
      overlay.remove();
      overlay = null;
    }
    document.documentElement.classList.remove('arclight-page-open');
  }

  function openOverlay(name) {
    if (overlay && overlay.getAttribute('data-page') === name) return null;
    closeOverlay();
    var header = Array.prototype.filter.call(document.querySelectorAll('.MuiAppBar-root, .skinHeader'), isVisible)[0];
    var top = header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom)) : 0;
    overlay = el('div', { class: 'arclight-page', 'data-page': name, role: 'main' });
    overlay.style.top = top + 'px';
    overlay.__place = function () {
      var h = Array.prototype.filter.call(document.querySelectorAll('.MuiAppBar-root, .skinHeader'), isVisible)[0];
      if (overlay) overlay.style.top = (h ? Math.max(0, Math.round(h.getBoundingClientRect().bottom)) : 0) + 'px';
    };
    var bg = getComputedStyle(document.body).backgroundColor;
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') bg = '#101010';
    overlay.style.backgroundColor = bg;
    document.body.appendChild(overlay);
    document.documentElement.classList.add('arclight-page-open');
    return overlay;
  }

  function discoverCards(category, page) {
    return call('GET', 'Discover?category=' + category + '&page=' + (page || 1));
  }

  function seeAllLink(category) {
    return el('a', { class: 'button-link arclight-section-link', href: pageHref('grid', { category: category }), text: t('seeAll') + ' ›' });
  }

  /** A row whose content can be reloaded (used by the trending day/week toggle). */
  function loadRow(holder, title, load, header) {
    holder.textContent = '';
    holder.appendChild(el('div', { class: 'arclight-muted', text: title + ' · ' + t('loading') }));
    load().then(function (cards) {
      if (!holder.isConnected) return;
      holder.textContent = '';
      holder.appendChild(scroller(title, cards.length ? cards : [el('div', { class: 'arclight-muted', text: t('nothingHere') })], header));
    }, function (err) {
      if (!holder.isConnected) return;
      holder.textContent = '';
      holder.appendChild(scroller(title, [el('div', { class: 'arclight-muted', text: errorMessage(err) })], header));
    });
  }

  function genreStrip(mediaType, title) {
    var strip = el('div', { class: 'arclight-genre-strip' });
    var section = el('div', { class: 'verticalSection arclight-section' }, [
      el('div', { class: 'sectionTitleContainer arclight-section-head' }, [el('h2', { class: 'sectionTitle arclight-section-title', text: title })]),
      strip
    ]);
    call('GET', 'Genres/' + mediaType).then(function (d) {
      ((d && d.genres) || []).forEach(function (g) {
        strip.appendChild(el('a', { class: 'arclight-chip arclight-genre-chip', href: pageHref('genre', { type: mediaType, genre: g.id, name: g.name }), text: g.name }));
      });
      if (!strip.childNodes.length) section.remove();
    }, function () { section.remove(); });
    return section;
  }

  function renderDiscoverPage(key) {
    var page = openOverlay(key);
    if (!page) return;
    var inner = el('div', { class: 'arclight-page-inner padded-left padded-right' }, [el('h1', { class: 'arclight-page-title', text: t('discover') })]);
    page.appendChild(inner);
    var cards = function (category) { return function () { return discoverCards(category, 1).then(function (d) { return ((d && d.results) || []).map(resultCard); }); }; };

    // Recommended for you
    var rec = el('div');
    inner.appendChild(rec);
    loadRow(rec, t('recommended'), cards('recommended'), seeAllLink('recommended'));

    // Trending with a day/week toggle
    var trending = el('div');
    inner.appendChild(trending);
    var windowNow = 'trendingDay';
    function trendingHeader() {
      var toggle = el('div', { class: 'arclight-toggle', role: 'group' });
      [['trendingDay', t('today')], ['trendingWeek', t('thisWeek')]].forEach(function (o) {
        toggle.appendChild(el('button', {
          type: 'button',
          class: 'emby-button arclight-toggle-btn' + (o[0] === windowNow ? ' arclight-toggle-on' : ''),
          'aria-pressed': String(o[0] === windowNow),
          text: o[1],
          onclick: function () { windowNow = o[0]; loadRow(trending, t('trendingTitle'), cards(windowNow), trendingHeader()); }
        }));
      });
      return el('span', { class: 'arclight-row-tools' }, [toggle, seeAllLink(windowNow)]);
    }
    loadRow(trending, t('trendingTitle'), cards(windowNow), trendingHeader());

    if (features().upcoming) {
      var soon = el('div');
      inner.appendChild(soon);
      loadUpcoming().then(function (items) {
        if (!soon.isConnected) return;
        if (!items.length) { soon.remove(); return; } // nothing coming: no empty row
        soon.appendChild(scroller(t('comingSoon'), items.map(upcomingCard)));
      }, function () { soon.remove(); });
    }

    if (statsAccess().leavingSoon) {
      var leaving = el('div', { class: 'arclight-leaving-soon' });
      inner.appendChild(leaving);
      call('GET', 'LeavingSoon').then(function (d) {
        if (!leaving.isConnected) return;
        var items = (d && Array.isArray(d.items) && d.items) || [];
        if (!items.length) { leaving.remove(); return; } // nothing leaving: no empty row
        leaving.appendChild(scroller(typeof d.name === 'string' && d.name ? d.name.slice(0, 80) : t('leavingSoon'), items.slice(0, 60).map(leavingCard)));
      }, function () { leaving.remove(); });
    }

    inner.appendChild(genreStrip('movie', t('movieGenres')));
    inner.appendChild(genreStrip('series', t('seriesGenres')));

    ['popularMovies', 'popularSeries', 'topRatedMovies', 'topRatedSeries', 'nowPlaying', 'upcomingMovies', 'airingToday', 'onTheAir'].forEach(function (cat) {
      var holder = el('div');
      inner.appendChild(holder);
      loadRow(holder, t(cat), cards(cat), seeAllLink(cat));
    });
  }

  /** A grid that loads further pages when its end scrolls into view. */
  function pagedGrid(container, loadPage) {
    var grid = el('div', { class: 'arclight-grid arclight-grid-page' });
    var sentinel = el('div', { class: 'arclight-sentinel arclight-muted', text: t('loading') });
    container.appendChild(grid);
    container.appendChild(sentinel);
    var page = 0;
    var total = 1;
    var busyLoading = false;
    var seen = {};
    function next() {
      if (busyLoading || page >= total || !grid.isConnected) return;
      busyLoading = true;
      loadPage(page + 1).then(function (d) {
        busyLoading = false;
        page = (d && d.page) || page + 1;
        total = Math.min((d && d.totalPages) || 1, 500);
        ((d && d.results) || []).forEach(function (r) {
          var k = r.mediaType + ':' + r.tmdbId;
          if (seen[k]) return;
          seen[k] = true;
          grid.appendChild(resultCard(r));
        });
        if (page >= total) {
          sentinel.textContent = grid.childNodes.length ? '' : t('nothingHere');
          if (observer) observer.disconnect();
        }
      }, function (err) {
        busyLoading = false;
        sentinel.textContent = errorMessage(err);
        total = 0;
      });
    }
    var observer = 'IntersectionObserver' in window
      ? new IntersectionObserver(function (entries) { if (entries.some(function (e) { return e.isIntersecting; })) next(); }, { root: overlay, rootMargin: '600px' })
      : null;
    if (observer) observer.observe(sentinel);
    next();
  }

  function renderGridPage(key, category) {
    var page = openOverlay(key);
    if (!page) return;
    var inner = el('div', { class: 'arclight-page-inner padded-left padded-right' }, [
      el('a', { class: 'button-link arclight-back', href: pageHref('discover'), text: '‹ ' + t('discover') }),
      el('h1', { class: 'arclight-page-title', text: t(category) })
    ]);
    page.appendChild(inner);
    pagedGrid(inner, function (n) { return discoverCards(category, n); });
  }

  function renderGenrePage(key, mediaType, genreId, name, sort) {
    var page = openOverlay(key);
    if (!page) return;
    sort = sort || 'popularity';
    var typeToggle = el('div', { class: 'arclight-toggle', role: 'group' });
    [['movie', t('movies')], ['series', t('series')]].forEach(function (o) {
      typeToggle.appendChild(el('button', {
        type: 'button',
        class: 'emby-button arclight-toggle-btn' + (o[0] === mediaType ? ' arclight-toggle-on' : ''),
        'aria-pressed': String(o[0] === mediaType),
        text: o[1],
        onclick: function () {
          if (o[0] === mediaType) return;
          // Movie and series genre ids differ: switch to the genre with the same name, else the first one.
          call('GET', 'Genres/' + o[0]).then(function (d) {
            var list = (d && d.genres) || [];
            var wanted = String(name || '').toLowerCase();
            // TMDB names some genres differently for series ("Sci-Fi & Fantasy", "Action & Adventure").
            var alias = { 'science fiction': 'sci-fi & fantasy', 'fantasy': 'sci-fi & fantasy', 'action': 'action & adventure', 'adventure': 'action & adventure', 'war': 'war & politics',
              'sci-fi & fantasy': 'science fiction', 'action & adventure': 'action', 'war & politics': 'war', 'kids': 'family' }[wanted];
            var byName = function (n) { return list.filter(function (g) { return g.name.toLowerCase() === n; })[0]; };
            var match = byName(wanted) || (alias && byName(alias)) || list[0];
            if (match) location.hash = pageHref('genre', { type: o[0], genre: match.id, name: match.name, sort: sort });
          });
        }
      }));
    });
    var sortSelect = el('select', { class: 'arclight-input emby-select arclight-sort', 'aria-label': t('sortBy') },
      [['popularity', t('sortPopularity')], ['rating', t('sortRating')], ['releaseDate', t('sortReleaseDate')], ['title', t('sortTitle')]].map(function (o) {
        return el('option', { value: o[0], text: o[1] });
      }));
    sortSelect.value = sort;
    sortSelect.addEventListener('change', function () {
      location.hash = pageHref('genre', { type: mediaType, genre: genreId, name: name, sort: sortSelect.value });
    });
    var inner = el('div', { class: 'arclight-page-inner padded-left padded-right' }, [
      el('a', { class: 'button-link arclight-back', href: pageHref('discover'), text: '‹ ' + t('discover') }),
      el('h1', { class: 'arclight-page-title', text: name || t('discover') }),
      el('div', { class: 'arclight-grid-tools' }, [typeToggle, el('label', { class: 'arclight-sort-label' }, [el('span', { text: t('sortBy') }), sortSelect])])
    ]);
    page.appendChild(inner);
    pagedGrid(inner, function (n) { return call('GET', 'DiscoverGenre/' + mediaType + '/' + genreId + '?sort=' + sort + '&page=' + n); });
  }

  // ------------------------------------------------------------------ title page (titles not in Jellyfin)
  function fact(label, value) {
    return value ? el('div', { class: 'arclight-fact' }, [el('span', { class: 'arclight-fact-label', text: label }), el('span', { text: value })]) : null;
  }

  function renderTitlePage(key, mediaType, tmdbId) {
    var page = openOverlay(key);
    if (!page) return;
    var inner = el('div', { class: 'arclight-title-page' }, [el('div', { class: 'arclight-muted padded-left', text: t('loading') })]);
    page.appendChild(inner);
    function load() {
      call('GET', 'Title/' + mediaType + '/' + tmdbId).then(function (d) { if (inner.isConnected) fill(d); }, function (err) {
        if (!inner.isConnected) return;
        inner.textContent = '';
        inner.appendChild(el('div', { class: 'arclight-page-inner padded-left padded-right' }, [el('p', { class: 'arclight-blocked', text: errorMessage(err) })]));
      });
    }
    function fill(d) {
      inner.textContent = '';
      var hero = el('div', { class: 'arclight-hero' });
      if (d.backdropUrl) hero.style.backgroundImage = 'url("' + encodeURI(d.backdropUrl) + '")';
      var poster = d.posterUrl
        ? el('img', { class: 'arclight-hero-poster', src: d.posterUrl, alt: '', referrerpolicy: 'no-referrer' })
        : el('div', { class: 'arclight-hero-poster arclight-poster-empty material-icons', 'aria-hidden': 'true', text: mediaType === 'series' ? 'tv' : 'movie' });
      var meta = [d.year, d.runtimeMinutes ? t('runtime', { n: d.runtimeMinutes }) : null, d.certification, d.voteAverage ? t('score', { n: Number(d.voteAverage).toFixed(1) }) : null].filter(Boolean).join(' · ');
      var genres = el('div', { class: 'arclight-genre-strip' }, (d.genres || []).map(function (g) {
        return el('a', { class: 'arclight-chip arclight-genre-chip', href: pageHref('genre', { type: mediaType, genre: g.id, name: g.name }), text: g.name });
      }));

      var actions = el('div', { class: 'arclight-actions arclight-title-actions' });
      var statusText = statusLabel(d.status);
      if (statusText) actions.appendChild(chip(statusText, d.status));
      if (d.jellyfinId) actions.appendChild(el('a', { class: 'emby-button raised arclight-action', href: '#/details?id=' + d.jellyfinId }, [el('span', { class: 'material-icons arclight-icon', 'aria-hidden': 'true', text: 'play_arrow' }), el('span', { class: 'arclight-action-label', text: t('openInJellyfin') })]));
      if (features().requests && d.canRequest) {
        actions.appendChild(el('button', { type: 'button', class: 'emby-button raised button-submit arclight-action', onclick: function () {
          openRequestDialog({ mediaType: mediaType, tmdbId: tmdbId, title: d.title, canRequest4k: d.canRequest4k }, load);
        } }, [el('span', { class: 'material-icons arclight-icon', 'aria-hidden': 'true', text: 'add' }), el('span', { class: 'arclight-action-label', text: t('request') })]));
      } else if (d.requestBlockedReason && d.requestBlockedReason !== 'available' && d.requestBlockedReason !== 'requested') {
        actions.appendChild(el('span', { class: 'arclight-blocked', text: blockedText(d.requestBlockedReason, mediaType) }));
      }
      if (features().watchlist) {
        var on = !!d.onWatchlist;
        var wl = actionButton(on ? t('watchlistRemove') : t('watchlistAdd'), on ? 'bookmark' : 'bookmark_border', function () {
          busy(wl, true);
          (on ? call('DELETE', 'Watchlist?mediaType=' + mediaType + '&tmdbId=' + tmdbId) : call('POST', 'Watchlist', { mediaType: mediaType, tmdbId: tmdbId })).then(function () {
            on = !on;
            state.watchlist = null;
            toast(on ? t('watchlistAdded') : t('watchlistRemoved'));
            wl.querySelector('.arclight-icon').textContent = on ? 'bookmark' : 'bookmark_border';
            wl.querySelector('.arclight-action-label').textContent = on ? t('watchlistRemove') : t('watchlistAdd');
            wl.classList.toggle('arclight-action-on', on);
          }, function (err) { toast(errorMessage(err), true); }).then(function () { busy(wl, false); });
        }, on);
        actions.appendChild(wl);
      }
      if (d.trailer && isHttpUrl(d.trailer.url) && /^https:\/\/(www\.youtube\.com|vimeo\.com)\//.test(d.trailer.url)) {
        actions.appendChild(el('a', { class: 'emby-button arclight-action', href: d.trailer.url, target: '_blank', rel: 'noopener noreferrer' }, [el('span', { class: 'material-icons arclight-icon', 'aria-hidden': 'true', text: 'smart_display' }), el('span', { class: 'arclight-action-label', text: t('trailer') })]));
      }
      if (features().issues) {
        var issueBtn = actionButton(t('reportProblem'), 'report_problem', function () {
          openIssueDialog({ mediaType: mediaType, tmdbId: tmdbId, name: d.title });
        });
        if (!d.inLibrary) { issueBtn.disabled = true; issueBtn.title = t('reportNeedsLibrary'); }
        actions.appendChild(issueBtn);
      }

      var rd = d.releaseDates || {};
      var dates = [
        rd.cinema ? t('inCinemas', { date: formatDate(rd.cinema) }) : null,
        rd.digital ? t('digitalRelease', { date: formatDate(rd.digital) }) : null,
        rd.physical ? t('physicalRelease', { date: formatDate(rd.physical) }) : null,
        rd.firstAirDate ? t('firstAired', { date: formatDate(rd.firstAirDate) }) : null,
        rd.lastAirDate ? t('lastAired', { date: formatDate(rd.lastAirDate) }) : null
      ].filter(Boolean).join(' · ');
      var facts = el('div', { class: 'arclight-facts' }, [
        fact(t('directedBy'), (d.directors || []).join(', ')),
        fact(t('createdBy'), (d.creators || []).join(', ')),
        fact(t('networks'), (d.networks || []).join(', ')),
        fact(t('studios'), (d.studios || []).slice(0, 4).join(', ')),
        fact(t('releaseDates'), dates)
      ]);

      hero.appendChild(el('div', { class: 'arclight-hero-inner padded-left padded-right' }, [
        poster,
        el('div', { class: 'arclight-hero-info' }, [
          el('h1', { class: 'arclight-hero-title', text: d.title }),
          meta ? el('div', { class: 'arclight-hero-meta', text: meta }) : null,
          genres,
          d.tagline ? el('div', { class: 'arclight-tagline', text: d.tagline }) : null,
          actions,
          d.overview ? el('p', { class: 'arclight-overview', text: d.overview }) : null,
          facts
        ])
      ]));
      inner.appendChild(hero);

      var body = el('div', { class: 'arclight-page-inner padded-left padded-right' });
      inner.appendChild(body);
      if (mediaType === 'series' && (d.seasons || []).length) {
        var seasonList = el('div', { class: 'arclight-season-list' });
        d.seasons.forEach(function (sn) {
          var label = statusLabel(sn.status);
          seasonList.appendChild(el('div', { class: 'arclight-season' }, [
            el('span', { class: 'arclight-season-name', text: sn.name || seasonLabel(sn.seasonNumber) }),
            el('span', { class: 'arclight-muted', text: t('episodes', { n: sn.episodeCount }) + (sn.airDate ? ' · ' + formatDate(sn.airDate) : '') }),
            label ? chip(label, sn.status) : el('span')
          ]));
        });
        body.appendChild(el('div', { class: 'verticalSection arclight-section' }, [el('h2', { class: 'sectionTitle arclight-section-title', text: t('seasonsHeading') }), seasonList]));
      }
      if ((d.cast || []).length) {
        body.appendChild(scroller(t('cast'), d.cast.map(function (c) {
          return el('div', { class: 'arclight-person' }, [
            c.profileUrl ? el('img', { class: 'arclight-person-img', src: c.profileUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : el('div', { class: 'arclight-person-img arclight-poster-empty material-icons', 'aria-hidden': 'true', text: 'person' }),
            el('div', { class: 'arclight-card-title', text: c.name }),
            el('div', { class: 'arclight-card-meta', text: c.character || '' })
          ]);
        })));
      }
      var providers = el('div', { class: 'arclight-section' });
      body.appendChild(providers);
      appendProviders(providers, mediaType, tmdbId);
      if ((d.recommendations || []).length) body.appendChild(scroller(t('moreLikeThis'), d.recommendations.map(resultCard)));
    }
    load();
  }

  function requestStatusText(s) {
    var key = 'status' + String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
    var v = t(key);
    return v === key ? String(s || '') : v;
  }

  function renderRequestsPage(key) {
    var page = openOverlay(key);
    if (!page) return;
    var list = el('div', { class: 'arclight-request-list' });
    var more = el('button', { type: 'button', class: 'emby-button raised arclight-btn hide', text: t('loadMore') });
    var inner = el('div', { class: 'arclight-page-inner padded-left padded-right' }, [el('h1', { class: 'arclight-page-title', text: t('myRequests') }), list, more]);
    page.appendChild(inner);
    var skip = 0;
    function row(r) {
      var poster = r.posterUrl
        ? el('img', { class: 'arclight-req-poster', src: r.posterUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
        : el('div', { class: 'arclight-req-poster arclight-poster-empty material-icons', 'aria-hidden': 'true', text: r.mediaType === 'series' ? 'tv' : 'movie' });
      var detail = r.language ? t(r.language.kind === 'subtitle' ? 'subtitleIn' : 'audioIn', { lang: r.language.language })
        : (r.seasons && r.seasons.length ? r.seasons.map(seasonLabel).join(', ') : '') + (r.is4k ? ' · 4K' : '');
      var progress = r.progress !== null && r.progress !== undefined
        ? el('div', { class: 'arclight-progress', title: percent(r.progress) + '%' }, [el('div', { class: 'arclight-progress-bar', style: 'width:' + percent(r.progress) + '%' })])
        : null;
      var actions = el('div', { class: 'arclight-req-actions' });
      var node = el('div', { class: 'arclight-req' }, [
        poster,
        el('div', { class: 'arclight-req-main' }, [
          el('a', { class: 'arclight-card-title arclight-card-link', href: titleHref(r.mediaType, r.tmdbId, r.jellyfinId), text: r.title + (r.year ? ' (' + r.year + ')' : '') }),
          detail ? el('div', { class: 'arclight-card-meta', text: detail }) : null,
          el('div', { class: 'arclight-chips' }, [chip(requestStatusText(r.status), r.status === 'pending' ? 'requested' : r.status === 'declined' || r.status === 'failed' ? 'missing' : 'processing')]),
          progress
        ]),
        actions
      ]);
      if (r.canCancel) {
        var btn = el('button', {
          type: 'button',
          class: 'emby-button arclight-action',
          onclick: function () {
            busy(btn, true);
            call('DELETE', 'Requests/' + r.id + '?kind=' + r.kind).then(function () {
              toast(t('requestCancelled'));
              node.remove();
            }, function (err) { busy(btn, false); toast(errorMessage(err), true); });
          }
        }, [el('span', { class: 'material-icons arclight-icon', 'aria-hidden': 'true', text: 'close' }), el('span', { class: 'arclight-action-label', text: t('cancelRequest') })]);
        actions.appendChild(btn);
      }
      return node;
    }
    function load() {
      busy(more, true);
      call('GET', 'Requests?take=20&skip=' + skip).then(function (data) {
        busy(more, false);
        var items = (data && data.items) || [];
        if (!items.length && skip === 0) list.appendChild(el('div', { class: 'arclight-muted', text: t('nothingHere') }));
        items.forEach(function (r) { list.appendChild(row(r)); });
        skip += items.length;
        more.classList.toggle('hide', !(data && data.total > skip));
      }, function (err) {
        busy(more, false);
        list.appendChild(el('div', { class: 'arclight-muted', text: errorMessage(err) }));
      });
    }
    more.addEventListener('click', load);
    load();
  }

  // ------------------------------------------------------------------ stats, Year in review, Leaving Soon
  function leavingCard(u) {
    var poster = u.posterUrl
      ? el('img', { class: 'arclight-poster-img', src: u.posterUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : el('div', { class: 'arclight-poster-empty material-icons', 'aria-hidden': 'true', text: u.mediaType === 'series' ? 'tv' : 'movie' });
    var href = u.tmdbId && /^(movie|series)$/.test(u.mediaType || '') ? titleHref(u.mediaType, u.tmdbId, u.jellyfinId) : (u.jellyfinId ? '#/details?id=' + u.jellyfinId : null);
    return el('div', { class: 'arclight-card' }, [
      el(href ? 'a' : 'div', { class: 'arclight-poster arclight-card-link', href: href }, [
        poster,
        u.removeAt ? el('span', { class: 'arclight-chip arclight-chip-leaving arclight-poster-chip', text: t('leavesOn', { date: formatDate(u.removeAt) }) }) : null
      ]),
      el(href ? 'a' : 'div', { class: 'arclight-card-title arclight-card-link', href: href, text: u.title || '' }),
      el('div', { class: 'arclight-card-meta', text: u.year ? String(u.year) : '' })
    ]);
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function formatCount(n) {
    try { return Number(n || 0).toLocaleString(document.documentElement.lang || undefined); } catch (e) { return String(n || 0); }
  }

  /** Watch time: "45m", "3h 20m", "2d 5h". */
  function formatWatch(ms) {
    var m = Math.round(num(ms) / 60000);
    if (m < 60) return t('durM', { m: m });
    var h = Math.floor(m / 60);
    if (h < 48) return t('durHM', { h: h, m: m % 60 });
    return t('durDH', { d: Math.floor(h / 24), h: h % 24 });
  }

  function weekdayName(i) {
    // 2023-01-01 was a Sunday (index 0).
    try { return new Date(2023, 0, 1 + i).toLocaleDateString(document.documentElement.lang || undefined, { weekday: 'short' }); } catch (e) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i] || ''; }
  }

  function weekdayLong(i) {
    try { return new Date(2023, 0, 1 + i).toLocaleDateString(document.documentElement.lang || undefined, { weekday: 'long' }); } catch (e) { return weekdayName(i); }
  }

  function monthName(m, long) {
    try { return new Date(2023, m - 1, 1).toLocaleDateString(document.documentElement.lang || undefined, { month: long ? 'long' : 'short' }); } catch (e) { return String(m); }
  }

  function hourLabel(h) {
    return (h < 10 ? '0' : '') + h + ':00';
  }

  function statTile(label, value) {
    return el('div', { class: 'arclight-stat' }, [
      el('div', { class: 'arclight-stat-value', text: value }),
      el('div', { class: 'arclight-stat-label', text: label })
    ]);
  }

  function statSection(title, children) {
    return el('section', { class: 'verticalSection arclight-section arclight-stats-section' }, [
      el('h2', { class: 'sectionTitle arclight-section-title', text: title })
    ].concat(children));
  }

  /** Horizontal bars: rows of [label, value, display]. */
  function barList(rows) {
    var max = rows.reduce(function (m, r) { return Math.max(m, num(r[1])); }, 0) || 1;
    return el('div', { class: 'arclight-barlist' }, rows.map(function (r) {
      return el('div', { class: 'arclight-barlist-row' }, [
        el('div', { class: 'arclight-barlist-label', text: r[0], title: r[0] }),
        el('div', { class: 'arclight-barlist-track' }, [el('div', { class: 'arclight-barlist-fill', style: 'width:' + Math.max(1, Math.round(num(r[1]) / max * 100)) + '%' })]),
        el('div', { class: 'arclight-barlist-value', text: r[2] })
      ]);
    }));
  }

  /** Vertical bars: [label, value, tooltip]; labels shown under the first, middle and last bar. */
  function columnChart(cols, labelEvery) {
    var max = cols.reduce(function (m, c) { return Math.max(m, num(c[1])); }, 0) || 1;
    var chart = el('div', { class: 'arclight-columns', role: 'img', 'aria-label': cols.map(function (c) { return c[2]; }).join(', ') });
    cols.forEach(function (c, i) {
      var h = num(c[1]) ? Math.max(2, Math.round(num(c[1]) / max * 100)) : 0;
      chart.appendChild(el('div', { class: 'arclight-column', title: c[2] }, [
        el('div', { class: 'arclight-column-fill', style: 'height:' + h + '%' }),
        el('div', { class: 'arclight-column-label', text: labelEvery && (i % labelEvery === 0 || i === cols.length - 1) ? c[0] : '' })
      ]));
    });
    return chart;
  }

  /** 7 x 24 plays heatmap (rows Sunday first, as Arclight sends it). */
  function heatmap(grid) {
    var rows = Array.isArray(grid) ? grid.slice(0, 7) : [];
    var max = 0;
    rows.forEach(function (r) { (Array.isArray(r) ? r : []).forEach(function (v) { max = Math.max(max, num(v)); }); });
    var table = el('div', { class: 'arclight-heatmap', role: 'table' });
    var head = el('div', { class: 'arclight-heat-row', role: 'row' }, [el('div', { class: 'arclight-heat-day' })]);
    for (var h = 0; h < 24; h++) head.appendChild(el('div', { class: 'arclight-heat-hour', text: h % 6 === 0 ? String(h) : '' }));
    table.appendChild(head);
    rows.forEach(function (r, d) {
      var row = el('div', { class: 'arclight-heat-row', role: 'row' }, [el('div', { class: 'arclight-heat-day', role: 'rowheader', text: weekdayName(d) })]);
      for (var hh = 0; hh < 24; hh++) {
        var v = num(Array.isArray(r) ? r[hh] : 0);
        var cell = el('div', { class: 'arclight-heat-cell', role: 'cell', title: t('heatCell', { day: weekdayName(d), hour: hourLabel(hh).slice(0, 2), n: v }) });
        if (v && max) cell.style.opacity = String(0.15 + 0.85 * v / max);
        else cell.classList.add('arclight-heat-empty');
        row.appendChild(cell);
      }
      table.appendChild(row);
    });
    return table;
  }

  function titleList(items) {
    return el('ol', { class: 'arclight-toplist' }, (items || []).slice(0, 10).map(function (x) {
      var label = (x.title || '') + (x.year ? ' (' + x.year + ')' : '');
      var href = x.jellyfinId ? '#/details?id=' + x.jellyfinId
        : x.tmdbId && (x.mediaType === 'movie' || x.mediaType === 'series') ? titleHref(x.mediaType, x.tmdbId, null) : null;
      return el('li', { class: 'arclight-toplist-row' }, [
        el(href ? 'a' : 'span', { class: 'arclight-toplist-title' + (href ? ' arclight-card-link' : ''), href: href, text: label }),
        el('span', { class: 'arclight-toplist-meta', text: t('playsAndTime', { n: formatCount(x.plays), time: formatWatch(x.watchMs) }) })
      ]);
    }));
  }

  function bucketBars(list) {
    return barList((list || []).slice(0, 10).map(function (b) { return [b.name || '', b.watchMs || b.plays, t('playsAndTime', { n: formatCount(b.plays), time: formatWatch(b.watchMs) })]; }));
  }

  /** The tabs between the stats pages this user may see: [page, label]. */
  function statsTabs() {
    var a = statsAccess();
    var tabs = [];
    if (a.myStats) tabs.push(['stats', t('myStats')]);
    if (a.wrapped) tabs.push(['wrapped', t('yearInReview')]);
    if (a.serverStats) tabs.push(['serverstats', t('serverStats')]);
    return tabs;
  }

  function statsHeader(current) {
    var tabs = statsTabs();
    var nav = el('nav', { class: 'arclight-toggle arclight-stats-tabs', 'aria-label': t('stats') });
    tabs.forEach(function (tab) {
      nav.appendChild(el('a', {
        class: 'emby-button arclight-toggle-btn' + (tab[0] === current ? ' arclight-toggle-on' : ''),
        href: pageHref(tab[0]),
        'aria-current': tab[0] === current ? 'page' : null,
        text: tab[1]
      }));
    });
    return tabs.length > 1 ? nav : null;
  }

  var STAT_PERIODS = [7, 30, 90, 365, 3650];

  function renderStatsPage(key, scope) {
    var page = openOverlay(key);
    if (!page) return;
    var server = scope === 'server';
    var days = 30;
    var picker = el('div', { class: 'arclight-toggle', role: 'group', 'aria-label': t('period') });
    var body = el('div', { class: 'arclight-stats-body' });
    var inner = el('div', { class: 'arclight-page-inner padded-left padded-right' }, [
      el('h1', { class: 'arclight-page-title', text: t(server ? 'serverStats' : 'myStats') }),
      statsHeader(server ? 'serverstats' : 'stats'),
      picker,
      body
    ]);
    page.appendChild(inner);
    var token = 0;

    function drawPicker() {
      picker.textContent = '';
      STAT_PERIODS.forEach(function (d) {
        picker.appendChild(el('button', {
          type: 'button',
          class: 'emby-button arclight-toggle-btn' + (d === days ? ' arclight-toggle-on' : ''),
          'aria-pressed': String(d === days),
          text: d === 3650 ? t('allTime') : t('lastDays', { n: d }),
          onclick: function () { if (d !== days) { days = d; load(); } }
        }));
      });
    }

    function draw(s) {
      body.textContent = '';
      var totals = s.totals || {};
      if (!num(totals.plays)) {
        body.appendChild(el('div', { class: 'arclight-muted arclight-empty', text: t('noPlays') }));
        return;
      }
      var tiles = [
        [t('plays'), formatCount(totals.plays)],
        [t('watchTime'), formatWatch(totals.watchMs)],
        [t('titlesWatched'), formatCount(totals.titles)],
        [t('moviesWatched'), formatCount(totals.movies)],
        [t('episodesWatched'), formatCount(totals.episodes)]
      ];
      if (server) tiles.push([t('viewers'), formatCount(totals.users)]);
      body.appendChild(el('div', { class: 'arclight-stat-grid' }, tiles.map(function (x) { return statTile(x[0], x[1]); })));

      var pm = s.playMethods || {};
      var methods = [['directPlay', pm.directPlay], ['directStream', pm.directStream], ['transcode', pm.transcode], ['unknownMethod', pm.unknown]]
        .filter(function (m) { return num(m[1]); })
        .map(function (m) { return [t(m[0]), m[1], formatCount(m[1])]; });

      var grid = el('div', { class: 'arclight-stats-columns' });
      if ((s.topMovies || []).length) grid.appendChild(statSection(t('topMovies'), [titleList(s.topMovies)]));
      if ((s.topSeries || []).length) grid.appendChild(statSection(t('topSeries'), [titleList(s.topSeries)]));
      if ((s.topGenres || []).length) grid.appendChild(statSection(t('topGenres'), [bucketBars(s.topGenres)]));
      if (methods.length) grid.appendChild(statSection(t('playMethods'), [barList(methods)]));
      if ((s.devices || []).length) grid.appendChild(statSection(t('devices'), [bucketBars(s.devices)]));
      if ((s.clients || []).length) grid.appendChild(statSection(t('clients'), [bucketBars(s.clients)]));
      if (server && (s.users || []).length) {
        grid.appendChild(statSection(t('mostActiveUsers'), [barList(s.users.slice(0, 10).map(function (u) {
          return [u.name || '', u.watchMs || u.plays, t('playsAndTime', { n: formatCount(u.plays), time: formatWatch(u.watchMs) })];
        }))]));
      }
      body.appendChild(grid);

      var perDay = (s.perDay || []).slice(-366);
      if (perDay.length) {
        body.appendChild(statSection(t('perDay'), [columnChart(perDay.map(function (d) {
          return [formatDate(d.date), d.watchMs, t('dayBar', { date: formatDate(d.date), time: formatWatch(d.watchMs) })];
        }), Math.max(1, Math.ceil(perDay.length / 6)))]));
      }
      if (Array.isArray(s.heatmap) && s.heatmap.length) body.appendChild(statSection(t(server ? 'heatmapServer' : 'heatmap'), [heatmap(s.heatmap)]));
    }

    function load() {
      drawPicker();
      var mine = ++token;
      body.textContent = '';
      body.appendChild(el('div', { class: 'arclight-muted', text: t('loading') }));
      call('GET', (server ? 'Stats/Server' : 'Stats/Me') + '?days=' + days).then(function (s) {
        if (mine !== token || !body.isConnected) return;
        draw(s || {});
      }, function (err) {
        if (mine !== token || !body.isConnected) return;
        body.textContent = '';
        body.appendChild(el('div', { class: 'arclight-muted', text: err && err.code === 'disabled' ? t('statsOff') : errorMessage(err) }));
      });
    }

    load();
  }

  /** A download name that is safe on every OS. */
  function safeFileName(name, year) {
    var n = String(name || '').replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/^[ .]+/, '').slice(0, 100);
    if (!n) n = 'year-in-review-' + year;
    if (!/\.svg$/i.test(n)) n += '.svg';
    return n;
  }

  function copyText(text, input) {
    function fallback() {
      try {
        input.focus();
        input.select();
        if (document.execCommand('copy')) { toast(t('copied')); return; }
      } catch (e) { /* fall through */ }
      toast(t('copyFailed'), true);
    }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast(t('copied')); }, fallback);
    } else {
      fallback();
    }
  }

  function renderWrappedPage(key, initialYear) {
    var page = openOverlay(key);
    if (!page) return;
    page.__urls = page.__urls || [];
    var year = initialYear && initialYear >= 2000 && initialYear <= 2100 ? initialYear : new Date().getFullYear();
    var select = el('select', { class: 'arclight-input emby-select arclight-year-select', 'aria-label': t('year') });
    var body = el('div', { class: 'arclight-stats-body' });
    var inner = el('div', { class: 'arclight-page-inner padded-left padded-right' }, [
      el('h1', { class: 'arclight-page-title', text: t('yearInReview') }),
      statsHeader('wrapped'),
      el('label', { class: 'arclight-row arclight-year-picker' }, [el('span', { class: 'arclight-label', text: t('year') }), select]),
      body
    ]);
    page.appendChild(inner);
    var token = 0;
    var knownYears = [];

    function fillYears(years) {
      (Array.isArray(years) ? years : []).forEach(function (y) {
        if (Number.isInteger(y) && y >= 2000 && y <= 2100 && knownYears.indexOf(y) < 0) knownYears.push(y);
      });
      var list = knownYears.slice();
      if (list.indexOf(year) < 0) list.push(year);
      list.sort(function (a, b) { return b - a; });
      select.textContent = '';
      list.forEach(function (y) {
        var o = el('option', { value: String(y), text: String(y) });
        if (y === year) o.selected = true;
        select.appendChild(o);
      });
    }
    select.addEventListener('change', function () { year = Number(select.value); load(); });

    function cardSection() {
      var holder = el('div', { class: 'arclight-wrapped-card' }, [el('div', { class: 'arclight-muted', text: t('loading') })]);
      var actions = el('div', { class: 'arclight-wrapped-actions' });
      var share = el('div', { class: 'arclight-wrapped-share' });
      var mine = token;
      call('GET', 'Wrapped/Image?year=' + year).then(function (img) {
        if (mine !== token || !holder.isConnected) return;
        holder.textContent = '';
        if (!img || typeof img.svg !== 'string' || !img.svg) { holder.remove(); return; }
        var blob = new Blob([img.svg], { type: 'image/svg+xml' });
        var objectUrl = URL.createObjectURL(blob);
        page.__urls.push(objectUrl);
        holder.appendChild(el('img', { class: 'arclight-wrapped-img', src: objectUrl, alt: t('yearInReview') + ' ' + year }));
        var fileName = safeFileName(img.fileName, year);
        actions.appendChild(el('a', { class: 'emby-button raised arclight-btn', href: objectUrl, download: fileName }, [
          el('span', { class: 'material-icons arclight-icon', 'aria-hidden': 'true', text: 'download' }), el('span', { text: t('downloadImage') })
        ]));
      }, function () { holder.remove(); });
      if (statsAccess().shareLinks) {
        var btn = el('button', { type: 'button', class: 'emby-button raised arclight-btn', onclick: function () {
          busy(btn, true);
          call('POST', 'Wrapped/Share', { year: year }).then(function (s) {
            busy(btn, false);
            share.textContent = '';
            var link = s && (typeof s.url === 'string' && /^https?:\/\//i.test(s.url) ? s.url : typeof s.path === 'string' ? s.path : '');
            if (!link) { toast(t('genericError', { code: 'share' }), true); return; }
            var input = el('input', { class: 'arclight-input arclight-share-url', type: 'text', readonly: true, value: link, 'aria-label': t('createShareLink') });
            share.appendChild(el('div', { class: 'arclight-muted', text: s.url ? t('shareLinkCreated') : t('shareLinkPath') }));
            share.appendChild(el('div', { class: 'arclight-row' }, [
              input,
              el('button', { type: 'button', class: 'emby-button arclight-btn', text: t('copy'), onclick: function () { copyText(link, input); } })
            ]));
            if (s.expiresAt) share.appendChild(el('div', { class: 'arclight-muted', text: t('shareLinkExpires', { date: formatDate(s.expiresAt) }) }));
            toast(t('shareLinkCreated'));
          }, function (err) { busy(btn, false); toast(errorMessage(err), true); });
        } }, [el('span', { class: 'material-icons arclight-icon', 'aria-hidden': 'true', text: 'share' }), el('span', { text: t('createShareLink') })]);
        actions.appendChild(btn);
      }
      return statSection(t('shareCard'), [holder, actions, share]);
    }

    function draw(w) {
      body.textContent = '';
      fillYears(w.years);
      body.appendChild(el('h2', { class: 'arclight-wrapped-name', text: t('wrappedTitle', { name: w.name || '', year: w.year || year }) }));
      if (!num(w.plays)) {
        body.appendChild(el('div', { class: 'arclight-muted arclight-empty', text: t('noPlaysYear', { year: year }) }));
        return;
      }
      var tiles = [
        [t('watchTime'), formatWatch(w.watchMs)],
        [t('plays'), formatCount(w.plays)],
        [t('moviesWatched'), formatCount(w.movies)],
        [t('episodesWatched'), formatCount(w.episodes)],
        [t('seriesWatched'), formatCount(w.series)],
        [t('activeDays'), formatCount(w.activeDays)]
      ];
      if (w.topDevice) tiles.push([t('topDevice'), String(w.topDevice)]);
      if (w.busiestMonth >= 1 && w.busiestMonth <= 12) tiles.push([t('busiestMonth'), monthName(w.busiestMonth, true)]);
      if (w.favouriteWeekday >= 0 && w.favouriteWeekday <= 6) tiles.push([t('favouriteDay'), weekdayLong(w.favouriteWeekday)]);
      if (w.favouriteHour >= 0 && w.favouriteHour <= 23) tiles.push([t('favouriteHour'), hourLabel(w.favouriteHour)]);
      if (w.longestDay && w.longestDay.date) tiles.push([t('longestDay'), t('longestDayValue', { date: formatDate(w.longestDay.date), time: formatWatch(w.longestDay.watchMs) })]);
      if (w.firstPlay && w.firstPlay.title) tiles.push([t('firstPlay'), t('firstPlayValue', { title: w.firstPlay.title, date: formatDate(w.firstPlay.at) })]);
      body.appendChild(el('div', { class: 'arclight-stat-grid' }, tiles.map(function (x) { return statTile(x[0], x[1]); })));
      if (typeof w.percentile === 'number' && w.percentile > 0) body.appendChild(el('div', { class: 'arclight-wrapped-percentile', text: t('percentile', { n: Math.round(w.percentile) }) }));

      var grid = el('div', { class: 'arclight-stats-columns' });
      if ((w.topMovies || []).length) grid.appendChild(statSection(t('topMovies'), [titleList(w.topMovies)]));
      if ((w.topSeries || []).length) grid.appendChild(statSection(t('topSeries'), [titleList(w.topSeries)]));
      if ((w.topGenres || []).length) grid.appendChild(statSection(t('topGenres'), [bucketBars(w.topGenres)]));
      body.appendChild(grid);
      if (Array.isArray(w.monthly) && w.monthly.length) {
        body.appendChild(statSection(t('perMonth'), [columnChart(w.monthly.slice(0, 12).map(function (ms, i) {
          return [monthName(i + 1), ms, monthName(i + 1, true) + ' · ' + formatWatch(ms)];
        }), 1)]));
      }
      body.appendChild(cardSection());
    }

    function load() {
      var mine = ++token;
      fillYears([]);
      body.textContent = '';
      body.appendChild(el('div', { class: 'arclight-muted', text: t('loading') }));
      call('GET', 'Wrapped?year=' + year).then(function (w) {
        if (mine !== token || !body.isConnected) return;
        draw(w || {});
      }, function (err) {
        if (mine !== token || !body.isConnected) return;
        body.textContent = '';
        body.appendChild(el('div', { class: 'arclight-muted', text: err && err.code === 'disabled' ? t('statsOff') : errorMessage(err) }));
      });
    }

    load();
  }

  function menuLinks() {
    var f = features();
    var links = [];
    if (f.discover) links.push(['#/home?arclight=discover', 'explore', t('discover')]);
    if (f.myRequests) links.push(['#/home?arclight=requests', 'playlist_add_check', t('myRequests')]);
    var firstStats = statsTabs()[0];
    if (firstStats) links.push([pageHref(firstStats[0]), 'insights', t('stats')]);
    return links;
  }

  function isVisible(node) {
    if (!node) return false;
    var r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Jellyfin Web has two shells: the classic one (.mainDrawer with a .customMenuOptions slot, used
  // by 10.11's default layout) and the React/MUI one (12.x default: a modal MUI Drawer created when
  // opened). Links are added to whichever exists; the MUI ones are clones of Jellyfin's own "Home"
  // entry so they pick up its exact styling.
  function addMenuLinks() {
    var links = menuLinks();
    if (!links.length) return;
    var slot = document.querySelector('.mainDrawer .customMenuOptions');
    if (slot && !slot.querySelector('.arclight-nav')) {
      links.forEach(function (l) {
        slot.appendChild(el('a', { is: 'emby-linkbutton', class: 'navMenuOption lnkMediaFolder emby-button arclight-nav', href: l[0] }, [
          el('span', { class: 'material-icons navMenuOptionIcon', 'aria-hidden': 'true', text: l[1] }),
          el('span', { class: 'navMenuOptionText', text: l[2] })
        ]));
      });
    }
    addAppBarLinks(links);
    var paper = document.querySelector('.MuiDrawer-paper');
    if (!paper || paper.querySelector('.arclight-nav')) return;
    var homeLink = paper.querySelector('a[href="#/home"]');
    var homeItem = homeLink && homeLink.closest('li');
    if (!homeItem || !homeItem.parentNode) return;
    var after = homeItem;
    var fav = paper.querySelector('a[href="#/home?tab=1"]');
    if (fav && fav.closest('li') && fav.closest('li').parentNode === homeItem.parentNode) after = fav.closest('li');
    links.forEach(function (l) {
      var item = homeItem.cloneNode(true);
      item.classList.add('arclight-nav');
      var a = item.querySelector('a');
      a.setAttribute('href', l[0]);
      a.classList.remove('Mui-selected');
      a.removeAttribute('aria-current');
      var icon = item.querySelector('svg');
      if (icon) icon.replaceWith(el('span', { class: 'material-icons arclight-nav-icon', 'aria-hidden': 'true', text: l[1] }));
      var text = item.querySelector('.MuiListItemText-primary, .MuiTypography-root') || a;
      text.textContent = l[2];
      a.addEventListener('click', function () {
        // Close the modal drawer the way a user would (backdrop click).
        var backdrop = document.querySelector('.MuiDrawer-root .MuiBackdrop-root');
        setTimeout(function () { if (backdrop && backdrop.isConnected) backdrop.click(); }, 0);
      });
      after.parentNode.insertBefore(item, after.nextSibling);
      after = item;
    });
  }

  /** 12.x desktop layout: user views are buttons in the app bar; add ours after them (clones of "Favorites"). */
  function addAppBarLinks(links) {
    var bars = document.querySelectorAll('.MuiAppBar-root');
    for (var i = 0; i < bars.length; i++) {
      var bar = bars[i];
      if (!isVisible(bar) || bar.querySelector('.arclight-nav')) continue;
      var fav = bar.querySelector('a[href="#/home?tab=1"]');
      if (!fav || !fav.parentNode) continue;
      var stack = fav.parentNode;
      var last = Array.prototype.filter.call(stack.children, function (c) { return c.tagName === 'A'; }).pop() || fav;
      links.forEach(function (l) {
        var a = fav.cloneNode(true);
        a.classList.add('arclight-nav');
        a.setAttribute('href', l[0]);
        a.classList.remove('active', 'Mui-selected');
        var svg = a.querySelector('svg');
        if (svg) svg.replaceWith(el('span', { class: 'material-icons arclight-nav-icon', 'aria-hidden': 'true', text: l[1] }));
        Array.prototype.slice.call(a.childNodes).forEach(function (n) { if (n.nodeType === 3) n.remove(); });
        a.appendChild(document.createTextNode(l[2]));
        stack.insertBefore(a, last.nextSibling);
        last = a;
      });
    }
  }

  /** Where header buttons go: before the user menu button of whichever header is visible. */
  function headerSlot() {
    var bars = document.querySelectorAll('.MuiAppBar-root');
    for (var i = 0; i < bars.length; i++) {
      if (!isVisible(bars[i])) continue;
      var buttons = Array.prototype.filter.call(bars[i].querySelectorAll('button'), isVisible);
      var user = buttons[buttons.length - 1];
      if (user && user.parentNode) return { parent: user.parentNode, before: user, className: user.className };
    }
    var right = document.querySelector('.skinHeader .headerRight');
    if (right && isVisible(right)) {
      var userBtn = right.querySelector('.headerUserButton') || right.lastElementChild;
      return { parent: right, before: userBtn, className: 'headerButton headerButtonRight paper-icon-button-light' };
    }
    return null;
  }

  // ------------------------------------------------------------------ themes
  var themeState = { loaded: false, data: null };

  function applyTheme(id) {
    var link = document.querySelector('link[data-arclight-theme]');
    if (!id) { if (link) link.remove(); return; }
    var href = url('Theme.css?theme=' + encodeURIComponent(id));
    if (link && link.getAttribute('href') === href) return;
    var next = el('link', { rel: 'stylesheet', href: href, 'data-arclight-theme': id });
    // Swap without a flash: add the new sheet, then drop the old one once it loaded.
    next.addEventListener('load', function () { if (link) link.remove(); });
    next.addEventListener('error', function () { next.remove(); });
    document.head.appendChild(next);
  }

  function loadTheme() {
    if (!features().themes) { applyTheme(null); return Promise.resolve(null); }
    return call('GET', 'Themes').then(function (data) {
      themeState.loaded = true;
      themeState.data = data;
      applyTheme(data && data.effective);
      return data;
    }, function () { return null; });
  }

  function openThemeDialog() {
    var data = themeState.data || {};
    var packs = (data.themes && data.themes.themes) || [];
    var nameOf = function (id) { var p = packs.filter(function (x) { return x.id === id; })[0]; return p ? p.name : id; };
    var options = [['', t('themeDefault', { name: data.defaultChoice === 'off' ? t('themeOff') : data.defaultChoice === 'follow' ? t('themeFollow') : nameOf(data.defaultChoice) })], ['off', t('themeOff')], ['follow', t('themeFollow')]]
      .concat(packs.map(function (p) { return [p.id, p.name]; }));
    var current = data.choice || '';
    var group = el('div', { class: 'arclight-form', role: 'radiogroup' });
    options.forEach(function (o) {
      var input = el('input', { type: 'radio', name: 'arclight-theme', value: o[0], class: 'arclight-check' });
      input.checked = o[0] === current;
      group.appendChild(el('label', { class: 'arclight-row' }, [input, el('span', { text: o[1] })]));
    });
    dialog(t('theme'), group, [
      { label: t('cancel') },
      {
        label: t('submit'),
        primary: true,
        onClick: function (close, button) {
          var picked = group.querySelector('input:checked');
          busy(button, true);
          call('POST', 'Themes/Choice', { choice: picked ? picked.value : '' }).then(function () {
            close();
            toast(t('themeSaved'));
            loadTheme();
          }, function (err) { busy(button, false); toast(errorMessage(err), true); });
          return false;
        }
      }
    ]);
  }

  function addThemeButton() {
    var f = features();
    var existing = document.querySelectorAll('.arclight-theme-button');
    var slot = headerSlot();
    for (var i = 0; i < existing.length; i++) {
      if (!f.themeChoice || !slot || existing[i].parentNode !== slot.parent) existing[i].remove();
    }
    if (!f.themeChoice || !slot || slot.parent.querySelector('.arclight-theme-button')) return;
    var btn = el('button', { type: 'button', class: slot.className + ' arclight-theme-button', title: t('theme'), 'aria-label': t('theme'), onclick: function () {
      (themeState.loaded ? Promise.resolve() : loadTheme()).then(openThemeDialog);
    } }, [el('span', { class: 'material-icons', 'aria-hidden': 'true', text: 'palette' })]);
    slot.parent.insertBefore(btn, slot.before);
  }

  // ------------------------------------------------------------------ routing
  function route() {
    loadConfig().then(function (cfg) {
      if (!cfg || !cfg.configured) return;
      var hp = hashParams();
      addMenuLinks();
      addThemeButton();
      if (!themeState.loaded && features().themes) loadTheme();
      scanCards();
      var arclightPage = hp.params.get('arclight');
      if (overlay && overlay.__place) overlay.__place();
      var key = location.hash;
      var p = hp.params;
      if (arclightPage === 'discover' && features().discover) { renderDiscoverPage(key); return; }
      if (arclightPage === 'requests' && features().myRequests) { renderRequestsPage(key); return; }
      var sa = statsAccess();
      if (arclightPage === 'stats' && sa.myStats) { renderStatsPage(key, 'me'); return; }
      if (arclightPage === 'serverstats' && sa.serverStats) { renderStatsPage(key, 'server'); return; }
      if (arclightPage === 'wrapped' && sa.wrapped) { renderWrappedPage(key, /^\d{4}$/.test(p.get('year') || '') ? Number(p.get('year')) : null); return; }
      if (arclightPage === 'grid' && features().discover && /^[a-zA-Z]{3,20}$/.test(p.get('category') || '')) { renderGridPage(key, p.get('category')); return; }
      if (arclightPage === 'genre' && features().discover && /^(movie|series)$/.test(p.get('type') || '') && /^\d+$/.test(p.get('genre') || '')) {
        renderGenrePage(key, p.get('type'), p.get('genre'), (p.get('name') || '').slice(0, 60), /^(popularity|rating|releaseDate|title)$/.test(p.get('sort') || '') ? p.get('sort') : 'popularity');
        return;
      }
      if (arclightPage === 'title' && /^(movie|series)$/.test(p.get('type') || '') && /^\d+$/.test(p.get('id') || '')) { renderTitlePage(key, p.get('type'), p.get('id')); return; }
      closeOverlay();
      if (hp.path === '/home' || hp.path === '/home.html' || hp.path === '') renderHomeRow();
      if (hp.path.indexOf('details') >= 0) {
        var id = hp.params.get('id');
        if (id && /^[0-9a-fA-F-]{32,36}$/.test(id)) renderDetails(id.replace(/-/g, '').toLowerCase());
      } else if (hp.path.indexOf('search') >= 0) {
        renderSearch();
      }
    });
  }

  var scheduleRoute = debounce(route, 200);

  function loadStyles() {
    if (document.querySelector('link[data-arclight]')) return;
    var script = document.querySelector('script[src*="Arclight/web/arclight.js"]');
    var href = script ? script.src.replace('arclight.js', 'arclight.css') : url('web/arclight.css');
    document.head.appendChild(el('link', { rel: 'stylesheet', href: href, 'data-arclight': '1' }));
  }

  function start() {
    loadStyles();
    window.addEventListener('hashchange', scheduleRoute);
    window.addEventListener('resize', debounce(function () { if (overlay && overlay.__place) overlay.__place(); }, 150));
    window.addEventListener('popstate', scheduleRoute);
    document.addEventListener('viewshow', scheduleRoute, true);
    new MutationObserver(function () { scheduleRoute(); }).observe(document.body, { childList: true, subtree: true });
    scheduleRoute();
  }

  function waitForClient(attempt) {
    var c = apiClient();
    if (c && typeof c.getUrl === 'function' && document.body) {
      start();
      return;
    }
    if (attempt > 600) return; // give up quietly after ~5 minutes
    setTimeout(function () { waitForClient(attempt + 1); }, 500);
  }

  window.__arclight = { version: 1, route: route, strings: STRINGS };
  waitForClient(0);
})();
