import { z } from 'zod';

// Its own module so households.ts can use it without importing auth.ts, which imports
// households.ts (ActiveProfileSummary): that cycle fails at load. auth.ts re-exports it.

/** A user's theme: a theme pack id (see themes.ts), `tron`, or `default` (the server default). */
export const ThemeName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
export type ThemeName = z.infer<typeof ThemeName>;
