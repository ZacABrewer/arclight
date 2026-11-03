import { StrictMode } from 'react';
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
import './styles/app.css';
import { AppServicesContext } from './app/context';
import { createAppRouter } from './app/router';
import { createServices } from './app/services';
import { parsePairingLink } from './core/qr';
import { applyAppLanguage } from './ui/settings';

async function boot(): Promise<void> {
  const rootEl = document.getElementById('root');
  if (!rootEl) throw new Error('#root element missing from index.html');
  document.documentElement.classList.add('in-app', 'app-native');

  const services = await createServices();
  await applyAppLanguage(services.settings.get().language).catch(() => undefined);
  const router = createAppRouter(services);

  // arclight://pair?server=…&code=… (the web player's QR code, opened by the camera app or a
  // link): go to sign-in, which pairs straight away.
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
      if (canGoBack) router.history.back();
      else void CapApp.minimizeApp();
    });
    // Coming back to the app: send queued progress, refresh what's stale.
    void CapApp.addListener('resume', () => {
      void services.flushProgress();
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
