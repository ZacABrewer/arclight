import type { CapacitorConfig } from '@capacitor/cli';
// The Capacitor CLI transpiles this file to CommonJS, so the JSON import becomes a require().
import pkg from './package.json';

const { version } = pkg;

// Arclight (the player app). Its whole UI is bundled (dist/), so it starts and plays downloads
// without a server. The WebView's origin is capacitor://localhost on iOS and https://localhost
// on Android; the user's server allows both in CORS for the app routes and sign-in uses a
// Bearer token, never cookies.
const config: CapacitorConfig = {
  appId: 'com.moviemethat.arclight',
  appName: 'Arclight',
  webDir: 'dist',
  // Capacitor's own native log prints every plugin call with its arguments, and those carry
  // signed links. 'debug' would still log them in debug builds (which get shared for testing), so
  // the bridge logs nothing in any build; the app's own logs go through SafeLog / core/redact.ts.
  loggingBehavior: 'none',
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
    hostname: 'localhost',
  },
  ios: {
    appendUserAgent: `ArclightPlayer/${version} (ios)`,
    contentInset: 'never',
    backgroundColor: '#02070a',
    scheme: 'App',
  },
  android: {
    appendUserAgent: `ArclightPlayer/${version} (android)`,
    backgroundColor: '#02070a',
    // Self-hosted servers are often plain http:// on the LAN; the app page is https://localhost,
    // so fetch() to them is active mixed content, which only MIXED_CONTENT_ALWAYS_ALLOW lets
    // through (compatibility mode allows images and media but still blocks fetch). The page's CSP
    // (index.html: script-src 'self', object-src 'none', no frames) keeps http scripts and frames
    // out, and which http servers may be used at all is the cleartext policy in core/transport.ts.
    allowMixedContent: true,
    captureInput: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 400,
      backgroundColor: '#02070a',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: { style: 'DARK', backgroundColor: '#02070a', overlaysWebView: true },
    SystemBars: { insetsHandling: 'css', style: 'DARK' },
    CapacitorHttp: { enabled: false },
    CapacitorCookies: { enabled: false },
  },
};

export default config;
