import type { CapacitorConfig } from '@capacitor/cli';
// The Capacitor CLI transpiles this file to CommonJS, so the JSON import becomes a require().
import pkg from './package.json';

const { version } = pkg;

const config: CapacitorConfig = {
  appId: 'com.moviemethat.arclight',
  appName: 'Arclight',
  webDir: 'dist',
  // The app's own screens are bundled; server pages are the user's server's own web UI, opened
  // in the same WebView. Which hosts may load in place is decided at runtime from the saved
  // servers by ArclightNativePlugin.shouldOverrideLoad (iOS/Android), so allowNavigation stays
  // empty: every other site opens in the system browser.
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
    hostname: 'localhost',
    // A server page that fails to load (server down, 502 from a proxy) hands over to the native
    // "can't reach server" screen.
    errorPath: 'unreachable.html',
  },
  ios: {
    // The web UI detects the app by this suffix (and shows app-only settings such as push).
    appendUserAgent: `ArclightApp/${version} (ios)`,
    contentInset: 'never',
    backgroundColor: '#02070a',
    scheme: 'App',
  },
  android: {
    appendUserAgent: `ArclightApp/${version} (android)`,
    backgroundColor: '#02070a',
    allowMixedContent: false,
    captureInput: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      launchShowDuration: 0,
      backgroundColor: '#02070a',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: { style: 'DARK', backgroundColor: '#02070a', overlaysWebView: true },
    SystemBars: { insetsHandling: 'css', style: 'DARK' },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
    CapacitorHttp: { enabled: false },
    CapacitorCookies: { enabled: false },
  },
};

export default config;
