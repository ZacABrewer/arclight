import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// Vitest globals are off, so RTL cannot register its own cleanup.
afterEach(() => cleanup());

// The full suite renders ~80 files in parallel jsdom workers; whole-page route renders
// (settings pages with several queries) can take over a second to settle under that load,
// which made the default 1 s findBy/waitFor timeout flaky. 5 s keeps real failures quick.
configure({ asyncUtilTimeout: 5000 });

// jsdom does not implement scrolling; the router's scroll restoration calls it.
window.scrollTo = () => {};
