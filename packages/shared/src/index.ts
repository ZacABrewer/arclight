// The API contract. Every request/response shape the api serves and the web consumes is
// defined here once as a Zod schema; both sides import the schema and its inferred type.

export * from './system.js';
export * from './jobs.js';
export * from './events.js';
export * from './quality.js';
export * from './profiles.js';
export * from './library.js';
export * from './indexers.js';
export * from './download-clients.js';
export * from './naming.js';
export * from './settings.js';
export * from './metadata.js';
export * from './releases.js';
export * from './imports.js';
export * from './history.js';
export * from './notifications.js';
export * from './calendar.js';
export * from './vpn.js';
export * from './auth.js';
export * from './import-lists.js';
export * from './logs.js';
export * from './requests.js';
export * from './compat.js';
export * from './migrate.js';
export * from './subtitles.js';
export * from './backup.js';
export * from './torrent.js';
export * from './solver.js';
