// First: console output is redacted (signed links) before any other module runs.
import './core/redact-install';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { ErrorBoundary } from '@web/components/error-boundary';
import { ToastProvider } from '@web/components/toast';
import { toasts } from '@web/lib/toast';
import { I18nProvider } from '@web/i18n/index';
import '@web/arclight/fonts';
import '@web/styles/arclight/index.css';
// The redesign kit's classes (avatars, tiles, picker); everything in it is scoped to .rd-* classes.
import '@web/features/player/redesign/redesign.css';
import './styles/app.css';
import { AppServicesContext } from './app/context';
import { createAppRouter } from './app/router';
import { createServices } from './app/services';
import { parsePairingLink } from './core/qr';
import { applyAppLanguage } from './ui/settings';
import { startTvRuntime } from './tv/tv-runtime';
import { IntroOverlay, introActive, skipIntro } from './intro/intro-overlay';
import { launchIntroMode } from './intro/launch';
import type { LaunchIntroMode } from './intro/policy';

// The launch intro sits above the app, which loads behind it. Cold launch only (§6): it is never
// shown before a video.
function Intro({ mode, tv }: { mode: LaunchIntroMode; tv: boolean }) {
  const [on, setOn] = useState(mode !== 'skip');
  if (!on || mode === 'skip') return null;
  return <IntroOverlay mode={mode} tv={tv} onDone={() => setOn(false)} />;
}

async function boot(): Promise<void> {
  const rootEl = document.getElementById('root');
  if (!rootEl) throw new Error('#root element missing from index.html');
  document.documentElement.classList.add('in-app', 'app-native');

  // Decided before anything renders, so the first frame is already the intro.
  const intro = await launchIntroMode().catch((): LaunchIntroMode => 'skip');
  const services = await createServices();
  await applyAppLanguage(services.settings.get().language).catch(() => undefined);
  const router = createAppRouter(services);
  // TV: D-pad focus across every screen, and Back that closes panels before leaving.
  const tv = services.tv ? startTvRuntime(router) : null;

  // arclight://pair?server=…&code=… (the web player's QR code, opened by the camera app or a
  // link): go to sign-in, which shows the server and pairs only once the user accepts it.
  const openLink = (url: string) => {
    const link = parsePairingLink(url);
    if (!link) return;
    void router.navigate({ to: '/sign-in', search: { server: link.server, ...(link.code ? { code: link.code } : {}) } });
  };
  if (Capacitor.isNativePlatform()) {
    void CapApp.addListener('appUrlOpen', (e) => openLink(e.url));
    void CapApp.getLaunchUrl()
      .then((l) => l?.url && openLink(l.url))
      .catch(() => undefined);
    // Back button (Android): back in history, or leave the app from a top screen.
    void CapApp.addListener('backButton', ({ canGoBack }) => {
      // While the intro is up, Back only ends it.
      if (introActive()) {
        skipIntro();
        return;
      }
      if (tv) {
        if (!tv.back(canGoBack)) void CapApp.minimizeApp();
        return;
      }
      if (canGoBack) router.history.back();
      else void CapApp.minimizeApp();
    });
    // Coming back to the app: send queued progress, refresh what's stale.
    void CapApp.addListener('resume', () => {
      services.resumed();
      void services.downloads.reconcile().catch(() => undefined);
    });
  }

  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary>
        <AppServicesContext.Provider value={services}>
          <QueryClientProvider client={services.qc}>
            <I18nProvider>
              <ToastProvider store={toasts}>
                <RouterProvider router={router} />
                <Intro mode={intro} tv={services.tv} />
              </ToastProvider>
            </I18nProvider>
          </QueryClientProvider>
        </AppServicesContext.Provider>
      </ErrorBoundary>
    </StrictMode>,
  );
  void import('@capacitor/splash-screen').then(({ SplashScreen }) => SplashScreen.hide()).catch(() => undefined);
}

void boot();
