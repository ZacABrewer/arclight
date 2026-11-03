import { useCallback, useEffect, useRef, useState } from 'react';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { originOf } from '../core/address.js';
import { probeServer, failureMessage, type ProbeFailure } from '../core/probe.js';
import { isSafePath, routeNotification, type RouteTarget } from '../core/routing.js';
import type { Server } from '../core/servers.js';
import { loadSettings } from '../core/settings.js';
import { confirmsHost, httpsAlternatives, type Verdict } from '../core/transport.js';
import { createRuntime, currentPushToken, isNative, openInWebView, type Runtime } from '../platform/capacitor.js';
import { ensureNotificationChannels, installHandlers, launchUrl, verifyBiometric } from '../platform/handlers.js';
import stingUrl from '../../../../design/brand/intro/arclight-sting.m4a?url';
import { IntroOverlay } from '../intro/IntroOverlay.js';
import { decideIntro, introSoundOn, markPlayed, readPlayed, type IntroMode } from '../intro/policy.js';
import { loadSting, type Sting } from '../intro/sting.js';
import { parseRoute, routeHash, type Route } from './route.js';
import { AboutScreen, AddServerScreen, LicensesScreen, LockScreen, ServerListScreen, SettingsScreen, TransportScreen } from './screens.js';
import { Mark, TopBar, haptic } from './ui.js';

type View =
  | { kind: 'route'; route: Route }
  | { kind: 'connecting'; server: Server }
  | { kind: 'unreachable'; server: Server; reason: ProbeFailure }
  /** A saved plain-http server that needs the one-time notice or the typed confirmation first. */
  | { kind: 'transport'; server: Server; verdict: Exclude<Verdict, { kind: 'ok' }>; path: string }
  | { kind: 'locked' }
  | { kind: 'booting' };

/** Time to wait on launch for a notification tap / share delivered by the native side. */
const LAUNCH_EVENT_GRACE_MS = 350;

const sessionStore = (): Storage | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};

/** Resolves after the next frame has been painted (or 150 ms, if frames are not running). */
const nextPaint = () =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 150);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(t);
        resolve();
      }),
    );
  });

export function App() {
  const rt = useRef<Runtime>(createRuntime()).current;
  const [view, setView] = useState<View>({ kind: 'booting' });
  const navigatedByEvent = useRef(false);
  const [typed, setTyped] = useState('');
  const lockWaiters = useRef<Array<() => void>>([]);
  const beforeLock = useRef<View | null>(null);
  // Startup intro (cold start only). A notification tap, share or deep link ends it at once.
  const [intro, setIntro] = useState<{ mode: Exclude<IntroMode, 'skip'>; sting: Sting | null } | null>(null);
  const launchEvent = useRef(false);
  const introEnded = useRef<() => void>(() => undefined);
  const introFinished = useRef<Promise<void>>(Promise.resolve());
  const endIntro = useCallback(() => {
    setIntro(null);
    introEnded.current();
    introEnded.current = () => undefined;
  }, []);

  const go = useCallback((route: Route) => {
    const hash = routeHash(route);
    if (window.location.hash !== hash) history.replaceState(null, '', hash);
    setView({ kind: 'route', route });
  }, []);

  const connectTo = useCallback(
    async (server: Server, path = '/') => {
      setView({ kind: 'connecting', server });
      await rt.servers.select(server.id);
      let target = server;
      let verdict = await rt.transport.verdict(server.url);
      if (verdict.kind === 'confirm' && verdict.reason === 'public') {
        // Prefer https: a saved plain-http server that answers over https now is moved there.
        const alts = await Promise.all(httpsAlternatives(server.url).map((u) => probeServer(rt.http, u)));
        const hit = alts.find((r) => r.ok);
        if (hit) {
          try {
            await rt.servers.updateUrl(server.id, hit.url);
            target = (await rt.servers.get(server.id)) ?? server;
            verdict = await rt.transport.verdict(target.url);
          } catch {
            /* another saved server already uses that address: ask instead */
          }
        }
      }
      if (verdict.kind !== 'ok') {
        setTyped('');
        setView({ kind: 'transport', server: target, verdict, path });
        return;
      }
      const result = await probeServer(rt.http, target.url);
      if (result.ok) {
        void haptic.tap();
        await rt.transport.pinHttps(target.url);
        await openInWebView(rt, `${target.url}${path}`);
      } else {
        void haptic.error();
        setView({ kind: 'unreachable', server: target, reason: result.reason });
      }
    },
    [rt],
  );

  /**
   * #/open?id=..&path=..: a server page handed over a notification tap for another server. id is
   * a saved server's id, or the base URL a notification named.
   */
  const openRoute = useCallback(
    async (id: string, path: string) => {
      const server = (await rt.servers.get(id)) ?? routeNotification({ server: id }, await rt.servers.list(), null)?.server;
      if (!server) return go({ name: 'servers' });
      navigatedByEvent.current = true;
      await connectTo(server, isSafePath(path) ? path : '/');
    },
    [rt, go, connectTo],
  );

  const lock = useCallback(
    () =>
      new Promise<void>((resolve) => {
        lockWaiters.current.push(resolve);
        setView((v) => {
          if (v.kind !== 'locked') beforeLock.current = v;
          return { kind: 'locked' };
        });
      }),
    [],
  );

  const unlock = useCallback(async () => {
    if (!(await verifyBiometric('Unlock to continue'))) return false;
    const waiters = lockWaiters.current;
    lockWaiters.current = [];
    setView(beforeLock.current ?? { kind: 'booting' });
    beforeLock.current = null;
    for (const w of waiters) w();
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (isNative()) {
        void StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined);
        void ensureNotificationChannels();
      }
      const servers = await rt.servers.list();
      await rt.syncNative();
      rt.servers.onChange(() => void rt.syncNative());

      // Push: move a pre-0.24 shared registration into the secure store, follow a token that
      // rotated while the app was closed, drop the shared relay device once nothing uses it.
      const origins = servers.map((s) => originOf(s.url));
      void (async () => {
        await rt.push.migrateLegacy(rt.kv);
        if ((await rt.push.states(origins)).length > 0) {
          const token = await currentPushToken();
          if (token) await rt.push.onTokenRefresh(token, origins);
        }
        await rt.push.reconcile(origins);
      })().catch(() => undefined);

      await installHandlers(rt, {
        currentServer: async () => null,
        open: async (target: RouteTarget) => {
          navigatedByEvent.current = true;
          endIntro();
          await rt.servers.select(target.server.id);
          await connectTo(target.server, target.url.slice(target.server.url.length) || '/');
        },
        pair: (url) => go({ name: 'add', url }),
        lock,
        pushScopes: async () => (await rt.servers.list()).map((s) => originOf(s.url)),
        onLaunchEvent: () => {
          launchEvent.current = true;
          endIntro();
        },
      });

      // Intro: decided before the splash goes, so the black splash hands off to its black first frame.
      const settings = await loadSettings(rt.kv);
      const mode = decideIntro({
        playIntro: settings.playIntro,
        alreadyPlayed: readPlayed(sessionStore()),
        reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
        launchedByEvent: launchEvent.current || (await launchUrl()) !== null,
        routeIsAuto: parseRoute(window.location.hash).name === 'auto',
      });
      if (mode !== 'skip' && !cancelled) {
        markPlayed(sessionStore());
        const sting = introSoundOn(mode, settings.introSound) ? await loadSting(stingUrl) : null;
        if (cancelled || launchEvent.current) {
          sting?.stop();
        } else {
          introFinished.current = new Promise<void>((resolve) => {
            introEnded.current = resolve;
          });
          setIntro({ mode, sting });
          await nextPaint();
        }
      }
      void SplashScreen.hide().catch(() => undefined);
      await introFinished.current;
      if (cancelled) return;

      // Biometric lock on launch.
      if (settings.biometricLock && isNative()) {
        const unlocked = lock();
        void unlock();
        await unlocked;
      }
      if (cancelled) return;

      const route = parseRoute(window.location.hash);
      if (route.name === 'open') return void (await openRoute(route.id, route.path));
      if (route.name !== 'auto' && route.name !== 'unreachable') return go(route);
      if (servers.length === 0) return go({ name: 'add' });
      const selected = (await rt.servers.selected()) ?? servers[0]!;
      if (route.name === 'unreachable') return setView({ kind: 'unreachable', server: selected, reason: 'unreachable' });

      // A notification tap or share that launched the app wins over opening the last server.
      await new Promise((r) => setTimeout(r, LAUNCH_EVENT_GRACE_MS));
      if (!navigatedByEvent.current && !cancelled) await connectTo(selected);
    })();
    const onHash = () => {
      const route = parseRoute(window.location.hash);
      if (route.name === 'open') void openRoute(route.id, route.path);
      else setView({ kind: 'route', route });
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', onHash);
    };
  }, [rt, go, connectTo, openRoute, lock, unlock, endIntro]);

  return (
    <>
      {renderView()}
      {intro && <IntroOverlay mode={intro.mode} sting={intro.sting} onDone={endIntro} />}
    </>
  );

  async function acceptTransport(v: Extract<View, { kind: 'transport' }>) {
    if (v.verdict.kind === 'confirm' && !confirmsHost(typed, v.verdict.host)) return;
    await rt.transport.accept(v.server.url, v.verdict);
    await connectTo(v.server, v.path);
  }

  function renderView() {
    switch (view.kind) {
      case 'booting':
        return (
          <main className="screen">
            <div className="center">
              <Mark />
            </div>
          </main>
        );
      case 'locked':
        return <LockScreen onUnlock={unlock} />;
      case 'connecting':
        return (
          <main className="screen" aria-busy="true">
            <div className="center">
              <Mark />
              <div className="spinner" role="progressbar" aria-label="Connecting" />
              <p>
                Connecting to <strong>{view.server.name}</strong>
              </p>
              <p className="muted small mono">{view.server.url}</p>
              <button type="button" className="btn ghost" onClick={() => go({ name: 'servers' })}>
                Cancel
              </button>
            </div>
          </main>
        );
      case 'unreachable':
        return (
          <main className="screen">
            <TopBar title="Can't reach server" />
            <div className="center">
              <Mark />
              <h2>{view.server.name}</h2>
              <p className="muted small mono">{view.server.url}</p>
              <p>{failureMessage(view.reason, new URL(view.server.url).host)}</p>
            </div>
            <div className="actions">
              <button type="button" className="btn accent block" onClick={() => void connectTo(view.server)}>
                Try again
              </button>
              <button type="button" className="btn block" onClick={() => go({ name: 'servers' })}>
                Switch server
              </button>
              <button type="button" className="btn ghost block" onClick={() => go({ name: 'edit', id: view.server.id })}>
                Edit address
              </button>
            </div>
          </main>
        );
      case 'transport':
        return <TransportScreen server={view.server} verdict={view.verdict} typed={typed} setTyped={setTyped} onAccept={() => void acceptTransport(view)} go={go} />;
      case 'route':
        switch (view.route.name) {
          case 'open':
            return (
              <main className="screen">
                <div className="center">
                  <Mark />
                </div>
              </main>
            );
          case 'servers':
          case 'auto':
          case 'unreachable':
            return <ServerListScreen rt={rt} go={go} connectTo={connectTo} />;
          case 'add':
            return <AddServerScreen rt={rt} go={go} connectTo={connectTo} {...(view.route.url ? { initialUrl: view.route.url } : {})} />;
          case 'edit':
            return <AddServerScreen rt={rt} go={go} connectTo={connectTo} editId={view.route.id} />;
          case 'settings':
            return <SettingsScreen rt={rt} go={go} />;
          case 'about':
            return <AboutScreen go={go} />;
          case 'licenses':
            return <LicensesScreen go={go} />;
        }
    }
  }
}
