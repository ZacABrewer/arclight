// Loose Zod schemas for the OpenLibrary JSON payloads we read. OpenLibrary records are
// crowd-edited and very uneven, so nearly everything is optional and objects are `.loose()`.

import { z } from 'zod';

const optString = z.string().nullable().optional();
const optNumber = z.number().nullable().optional();
const optStrings = z.array(z.string()).nullable().optional();
const optNumbers = z.array(z.number()).nullable().optional();

/** Free text is either a string or `{ type: "/type/text", value }`. */
export const olTextSchema = z
  .union([z.string(), z.object({ value: z.string().optional() }).loose()])
  .nullable()
  .optional();

const keyRefSchema = z.object({ key: z.string() }).loose();

export const olAuthorSearchDocSchema = z
  .object({
    key: z.string(),
    name: optString,
    alternate_names: optStrings,
    birth_date: optString,
    death_date: optString,
    top_work: optString,
    work_count: optNumber,
    top_subjects: optStrings,
  })
  .loose();
export type OlAuthorSearchDocWire = z.infer<typeof olAuthorSearchDocSchema>;

export const olAuthorSearchSchema = z
  .object({
    numFound: optNumber,
    start: optNumber,
    docs: z.array(olAuthorSearchDocSchema).nullable().optional(),
  })
  .loose();

export const olAuthorSchema = z
  .object({
    key: z.string(),
    name: optString,
    personal_name: optString,
    alternate_names: optStrings,
    bio: olTextSchema,
    birth_date: optString,
    death_date: optString,
    photos: optNumbers,
    remote_ids: z.record(z.string(), z.unknown()).nullable().optional(),
    links: z
      .array(z.object({ title: optString, url: optString }).loose())
      .nullable()
      .optional(),
  })
  .loose();
export type OlAuthorWire = z.infer<typeof olAuthorSchema>;

export const olWorkSchema = z
  .object({
    key: z.string(),
    title: optString,
    subtitle: optString,
    description: olTextSchema,
    authors: z
      .array(z.object({ author: keyRefSchema.nullable().optional() }).loose())
      .nullable()
      .optional(),
    subjects: optStrings,
    covers: optNumbers,
    first_publish_date: optString,
    series: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  })
  .loose();
export type OlWorkWire = z.infer<typeof olWorkSchema>;

export const olWorksPageSchema = z
  .object({
    size: optNumber,
    entries: z.array(olWorkSchema).nullable().optional(),
    links: z.object({ next: optString, prev: optString }).loose().nullable().optional(),
  })
  .loose();

export const olEditionSchema = z
  .object({
    key: z.string(),
    title: optString,
    subtitle: optString,
    full_title: optString,
    description: olTextSchema,
    authors: z.array(keyRefSchema).nullable().optional(),
    works: z.array(keyRefSchema).nullable().optional(),
    publish_date: optString,
    publishers: optStrings,
    covers: optNumbers,
    isbn_10: optStrings,
    isbn_13: optStrings,
    languages: z.array(keyRefSchema).nullable().optional(),
    number_of_pages: optNumber,
    physical_format: optString,
    series: optStrings,
    identifiers: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .loose();
export type OlEditionWire = z.infer<typeof olEditionSchema>;

export const olBookSearchDocSchema = z
  .object({
    key: z.string(),
    title: optString,
    subtitle: optString,
    author_name: optStrings,
    author_key: optStrings,
    first_publish_year: optNumber,
    isbn: optStrings,
    cover_i: optNumber,
    language: optStrings,
    publisher: optStrings,
    edition_count: optNumber,
    subject: optStrings,
    id_amazon: optStrings,
  })
  .loose();
export type OlBookSearchDocWire = z.infer<typeof olBookSearchDocSchema>;

export const olBookSearchSchema = z
  .object({
    numFound: optNumber,
    start: optNumber,
    docs: z.array(olBookSearchDocSchema).nullable().optional(),
  })
  .loose();
