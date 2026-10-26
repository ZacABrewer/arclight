# Developing Arclight

Read [CONVENTIONS.md](CONVENTIONS.md) first; this page is the how-to. Commands are in the
README (`pnpm dev`, `build`, `test`, `typecheck`, `db:generate`).

## Add an api module

1. Create `apps/api/src/modules/<name>/` with `schema.ts`, `service.ts`, `routes.ts`,
   optional `jobs.ts`, `index.ts` and colocated `*.test.ts`.
2. The module type is `AppModule` from `apps/api/src/app.ts`:
   `(ctx: AppContext) => FastifyPluginAsync`. `AppContext` carries `config`, `db`, `bus`
   (event bus), `scheduler`, `log` and `startedAt`. Routes are registered relative to
   `/api/v1`. A typical module:

   ```ts
   export const exampleModule: AppModule = (ctx) => async (app) => {
     const service = new ExampleService(ctx.db, ctx.bus);
     await app.register(exampleRoutes(service));
     registerExampleJobs(ctx.scheduler, service);
   };
   ```

   Use the Zod schemas from `@arclight/shared` in the route `schema` (`body`, `params`,
   `querystring`, `response`); the Zod type provider validates and serializes. Keep routes
   thin and map service errors to HTTP in one place.
3. Jobs: `scheduler.register({ name, cron, handler })`. The handler may return a message
   string stored on the job run. Names are PascalCase (`RssSync`).
4. Add the module to the `modules` array in `apps/api/src/app.ts`.
5. Tables: define them in `<name>/schema.ts`, then add
   `export * from '../modules/<name>/schema.js';` to `apps/api/src/db/schema.ts` (the
   aggregate). Other modules import tables from that aggregate, never from another
   module's `schema.ts`.
6. Migration: run `pnpm db:generate` (drizzle-kit; output in `apps/api/drizzle/`) and
   commit the generated `.sql` and `meta/` files. Do not hand-edit generated SQL.
7. Add the routes and jobs to [API.md](API.md).

### Testing a module

`createTestDb(extraTables?)` in `apps/api/src/db/test-utils.ts` returns an in-memory
SQLite `Db` built from the table definitions (not from the shipped migrations), so you can
test before running `db:generate`. Pass your module's tables as `extraTables` if they are
not yet in the aggregate. For route tests, build a Fastify instance with the Zod
compilers and register your module with a context made from the test db; see
`modules/download-clients/routes.test.ts` and `test-support.ts`. Fake external services
(TMDB, qBittorrent, indexers) with an injected `fetch`; never call live services.

## Add a shared contract

1. Put the Zod schema and its inferred type in `packages/shared/src/<area>.ts`:
   `export const Thing = z.object({...}); export type Thing = z.infer<typeof Thing>;`
2. Export the file from `packages/shared/src/index.ts` (`export * from './<area>.js';`).
3. Use it in the api route schema and in the web client (`apps/web/src/api/`), which
   parses responses with the same schema. Never define an API shape anywhere else.
4. A new WebSocket event goes into the `ServerEvent` union in `events.ts`; the web's
   `live.ts` handles it.
5. Dates are ISO-8601 strings, durations are ms, sizes are bytes.

The shared package has no tests of its own; contracts are exercised through the api and
web tests.

## Add a package

1. `packages/<name>/package.json`: `"name": "@arclight/<name>"`, `"private": true`,
   `"type": "module"`, `"exports": { ".": "./src/index.ts" }`, scripts `typecheck`
   (`tsc --noEmit`) and `test` (`vitest run`). Copy `packages/organizer` as a template,
   including its `tsconfig.json`.
2. Depend on `@arclight/shared` with `"workspace:*"` only if you use contract types.
3. `src/index.ts` is the public API; keep everything else internal. No database or HTTP
   server code in packages.
4. In the consumer (`apps/api` or another package) add `"@arclight/<name>": "workspace:*"`
   and run `pnpm install`.
5. If it must ship in the image, check `docker/Dockerfile`: its install layer copies
   individual `package.json` files, so a new package has to be added there too.
6. Any new third-party dependency needs a reason in the commit message.

## Fixture-driven parser tests

`packages/parser/fixtures/<area>/*.json` hold cases as data (`{ "cases": [ ... ] }`),
grouped by area: `group`, `language`, `movies`, `path`, `quality`, `scene`, `series`.
`src/fixture-check.ts` (`checkCase`) compares the parser output with a case's
expectations. Fixtures are test inputs and expected values only; never copy upstream code
or regexes.

- `pnpm --filter @arclight/parser test` runs the Vitest suites (`group`, `language`,
  `quality`).
- `pnpm --filter @arclight/parser report` runs every fixture file and prints the pass
  rate per file with the first six failures. `-- <substring>` filters by path, `-- --all`
  lists every failure, and the last line is the total. Use it as the loop when improving
  the parser: the total should rise without any file regressing.
- To add cases, append to the matching JSON file, or add a new `.json` file under the right
  folder (the report walks the folder recursively), then rerun the report.

## Commit conventions

- Imperative subject, 72 characters or fewer; the body explains why. Recent subjects look
  like "Phase 1 wave 2: library, profiles, indexers, download clients, web shell".
- Body bullets list what changed per area, with test counts where useful.
- Give a reason for any new dependency and name the package it is for.
- End with the Co-Authored-By line the session provides.
- Run `pnpm typecheck` and `pnpm test` before committing; keep generated migrations in
  the same commit as the schema change.
