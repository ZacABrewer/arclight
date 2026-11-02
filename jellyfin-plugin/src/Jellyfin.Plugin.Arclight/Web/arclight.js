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
      size: '{size}'
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
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

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
    linked: true
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
    return call('GET', 'ClientConfig').then(function (cfg) {
      state.config = cfg;
      return cfg;
    }, function () {
      state.config = null;
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
    var card = el('div', { class: 'arclight-card', title: r.overview || '' }, [
      el('div', { class: 'arclight-poster' }, [poster, label ? el('span', { class: 'arclight-chip arclight-chip-' + r.status + ' arclight-poster-chip', text: label }) : null]),
      el('div', { class: 'arclight-card-title', text: r.title || '' }),
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
      var attribution = data.link
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
    return el('div', { class: 'arclight-card' }, [
      el('div', { class: 'arclight-poster' }, [poster, el('span', { class: 'arclight-chip arclight-chip-upcoming arclight-poster-chip', text: formatDate(u.date) })]),
      el('div', { class: 'arclight-card-title', text: u.title || '' }),
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
    if (overlay) { overlay.remove(); overlay = null; }
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

  function renderDiscoverPage() {
    var page = openOverlay('discover');
    if (!page) return;
    var inner = el('div', { class: 'arclight-page-inner padded-left padded-right' }, [el('h1', { class: 'arclight-page-title', text: t('discover') })]);
    page.appendChild(inner);
    var rows = [];
    if (features().upcoming) rows.push({ title: t('comingSoon'), load: function () { return loadUpcoming().then(function (items) { return items.map(upcomingCard); }); } });
    ['trending', 'popularMovies', 'popularSeries', 'upcomingMovies', 'upcomingSeries'].forEach(function (cat) {
      rows.push({ title: t(cat), load: function () { return call('GET', 'Discover?category=' + cat + '&page=1').then(function (d) { return ((d && d.results) || []).map(resultCard); }); } });
    });
    rows.forEach(function (r) {
      var holder = el('div', {}, [el('div', { class: 'arclight-muted', text: r.title + ' · ' + t('loading') })]);
      inner.appendChild(holder);
      r.load().then(function (cards) {
        if (!holder.isConnected) return;
        holder.textContent = '';
        holder.appendChild(scroller(r.title, cards.length ? cards : [el('div', { class: 'arclight-muted', text: t('nothingHere') })]));
      }, function (err) {
        if (!holder.isConnected) return;
        holder.textContent = '';
        holder.appendChild(scroller(r.title, [el('div', { class: 'arclight-muted', text: errorMessage(err) })]));
      });
    });
  }

  function requestStatusText(s) {
    var key = 'status' + String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
    var v = t(key);
    return v === key ? String(s || '') : v;
  }

  function renderRequestsPage() {
    var page = openOverlay('requests');
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
          el('div', { class: 'arclight-card-title', text: r.title + (r.year ? ' (' + r.year + ')' : '') }),
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

  function menuLinks() {
    var f = features();
    var links = [];
    if (f.discover) links.push(['#/home?arclight=discover', 'explore', t('discover')]);
    if (f.myRequests) links.push(['#/home?arclight=requests', 'playlist_add_check', t('myRequests')]);
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
      if (arclightPage === 'discover' && features().discover) { renderDiscoverPage(); return; }
      if (arclightPage === 'requests' && features().myRequests) { renderRequestsPage(); return; }
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
