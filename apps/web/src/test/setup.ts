import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Vitest globals are off, so RTL cannot register its own cleanup.
afterEach(() => cleanup());

// jsdom does not implement scrolling; the router's scroll restoration calls it.
window.scrollTo = () => {};
