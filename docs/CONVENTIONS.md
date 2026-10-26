# Conventions

Read this before writing any code in this repo. Several people and agents work in parallel;
these rules are what keep the result one codebase.

## Ground rules

1. **Clean room.** Upstream projects (Sonarr, Radarr, Prowlarr, Bazarr, Seerr, in
   `../reference/`) are behaviour references. Read them to learn *what* happens; write
   *how* yourself. Never copy code, regexes, SQL or comments from them. Test inputs and
   expected values are data and may be used as fixtures.
2. **TypeScript strict, ESM, Node 24.** `tsconfig.base.json` is the law
   (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). No `any` without a comment
   saying why.
3. **One package per concern, one module per feature.** A `packages/*` library has zero
   knowledge of the database or HTTP; it is pure logic + external-service clients, testable
   in isolation. An `apps/api/src/modules/*` module owns its tables, routes, services and
   jobs and talks to packages.
4. **Contract first.** Every request/response shape lives in `packages/shared/src/<area>.ts`
   as a Zod schema with an inferred type, exported from `packages/shared/src/index.ts`.
   The api validates with it; the web parses with it. Never define an API shape anywhere else.
5. **Tests are Vitest**, colocated as `*.test.ts`, run with `pnpm test`. Pure packages
   aim for fixture-driven tests; external clients are tested against recorded or
   hand-written response fixtures in `fixtures/`, never live services.
6. **No new dependencies without a reason in the PR/commit message.** Prefer Node built-ins
   (`fetch`, `node:crypto`, `node:fs/promises`). Approved so far: fastify (+cors, static,
   websocket), fastify-type-provider-zod, zod, drizzle-orm, better-sqlite3, croner, pino,
   fast-xml-parser (indexers), react, @tanstack/react-query, vite.
7. **Dates are ISO-8601 strings** across the API and DB (`text` columns). Durations are
   milliseconds as integers. Sizes are bytes as integers.
8. **Logging** through the pino logger passed in context; never `console.*` in api code.
9. **Errors**: throw typed errors (`class XError extends Error` with a `code`) from packages;
   modules map them to HTTP in one place.

## Module layout (`apps/api/src/modules/<name>/`)

```
schema.ts     drizzle tables for this module (re-exported by src/db/schema.ts)
service.ts    business logic; takes `AppContext` + typed inputs; no Fastify types
routes.ts     Fastify routes under /api/v1/<name>; thin: validate → service → reply
jobs.ts       scheduler.register(...) calls, if any
index.ts      export const <name>Module: AppModule = (ctx) => async (app) => { routes; jobs }
*.test.ts
```

A module never imports another module's `schema.ts` directly; it imports from
`src/db/schema.ts` (the aggregate) so cross-module joins are visible in one place.

## Package layout (`packages/<name>/`)

```
package.json  name "@arclight/<name>", type module, exports "./src/index.ts"
src/index.ts  public API only
src/**        implementation
fixtures/**   test data
```

Packages depend on `@arclight/shared` for domain types when they are part of the API
contract; otherwise they define their own types and `shared` re-exports what the API needs.

## Naming

- Files: `kebab-case.ts`. Types/classes: `PascalCase`. Functions/vars: `camelCase`.
  DB columns: `snake_case` in SQL, `camelCase` in Drizzle property names.
- Series/episode terms follow TV convention: `series`, `season`, `episode`, `absoluteEpisode`,
  `airDate`. Movie terms: `movie`, `year`, `edition`. Both share `title`, `sortTitle`,
  `cleanTitle`, `monitored`, `qualityProfileId`, `rootFolderPath`, `path`, `tags`.
- A "release" is a candidate download found at an indexer. A "grab" sends it to a download
  client. An "import" moves a completed download into the library. "Wanted" is monitored
  and missing or below cutoff.

## Quality vocabulary

Quality definitions are an ordered enum shared by parser, profiles and decision engine:
see `packages/shared/src/quality.ts`. Use its ids and names everywhere; do not invent
quality strings.

## Commit messages

Imperative subject ≤ 72 chars, body explains why, ends with the Co-Authored-By line the
session provides.
