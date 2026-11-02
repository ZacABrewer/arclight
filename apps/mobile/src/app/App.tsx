import { useCallback, useEffect, useRef, useState } from 'react';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { probeServer, failureMessage, type ProbeFailure } from '../core/probe.js';
import type { RouteTarget } from '../core/routing.js';
import type { Server } from '../core/servers.js';
import { loadSettings } from '../core/settings.js';
import { createRuntime, isNative, openInWebView, syncServerOrigins, type Runtime } from '../platform/capacitor.js';
import { ensureNotificationChannels, installHandlers, launchUrl, verifyBiometric } from '../platform/handlers.js';
import stingUrl from '../../../../design/brand/intro/arclight-sting.m4a?url';
import { IntroOverlay } from '../intro/IntroOverlay.js';
import { decideIntro, introSoundOn, markPlayed, readPlayed, type IntroMode } from '../intro/policy.js';
import { loadSting, type Sting } from '../intro/sting.js';
import { parseRoute, routeHash, type Route } from './route.js';
import { AboutScreen, AddServerScreen, LicensesScreen, LockScreen, ServerListScreen, SettingsScreen } from './screens.js';
import { Mark, TopBar, haptic } from './ui.js';

type View =
  | { kind: 'route'; route: Route }
  | { kind: 'connecting'; server: Server }
  | { kind: 'unreachable'; server: Server; reason: ProbeFailure }
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
      const result = await probeServer(rt.http, server.url);
      if (result.ok) {
        void haptic.tap();
        await openInWebView(rt, `${server.url}${path}`);
      } else {
        void haptic.error();
        setView({ kind: 'unreachable', server, reason: result.reason });
      }
    },
    [rt],
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
      await syncServerOrigins(servers);
      rt.servers.onChange((s) => void syncServerOrigins(s));

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
      if (route.name !== 'auto' && route.name !== 'unreachable') return go(route);
      if (servers.length === 0) return go({ name: 'add' });
      const selected = (await rt.servers.selected()) ?? servers[0]!;
      if (route.name === 'unreachable') return setView({ kind: 'unreachable', server: selected, reason: 'unreachable' });

      // A notification tap or share that launched the app wins over opening the last server.
      await new Promise((r) => setTimeout(r, LAUNCH_EVENT_GRACE_MS));
      if (!navigatedByEvent.current && !cancelled) await connectTo(selected);
    })();
    const onHash = () => setView({ kind: 'route', route: parseRoute(window.location.hash) });
    window.addEventListener('hashchange', onHash);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', onHash);
    };
  }, [rt, go, connectTo, lock, unlock, endIntro]);

  return (
    <>
      {renderView()}
      {intro && <IntroOverlay mode={intro.mode} sting={intro.sting} onDone={endIntro} />}
    </>
  );

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
      case 'route':
        switch (view.route.name) {
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
