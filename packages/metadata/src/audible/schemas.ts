// Zod schemas for the unofficial Audible catalog API. Nothing about it is documented or
// guaranteed, so every field is optional and nullable and objects are `.loose()`; the mapper
// skips products without an ASIN or title instead of failing the whole page.

import { z } from 'zod';

const optString = z.string().nullable().optional();
const optNumber = z.number().nullable().optional();
const optBoolean = z.boolean().nullable().optional();
const optNumeric = z.union([z.string(), z.number()]).nullable().optional();

export const audContributorSchema = z.object({ asin: optString, name: optString }).loose();

export const audSeriesSchema = z
  .object({ asin: optString, title: optString, sequence: optNumeric, url: optString })
  .loose();

export const audLadderSchema = z
  .object({
    root: optString,
    ladder: z
      .array(z.object({ id: optString, name: optString }).loose())
      .nullable()
      .optional(),
  })
  .loose();

const audDistributionSchema = z
  .object({
    average_rating: optNumber,
    display_average_rating: optString,
    num_ratings: optNumber,
  })
  .loose();

export const audRatingSchema = z
  .object({
    num_reviews: optNumber,
    overall_distribution: audDistributionSchema.nullable().optional(),
  })
  .loose();

export const audProductSchema = z
  .object({
    asin: optString,
    title: optString,
    subtitle: optString,
    authors: z.array(audContributorSchema).nullable().optional(),
    narrators: z.array(audContributorSchema).nullable().optional(),
    series: z.array(audSeriesSchema).nullable().optional(),
    category_ladders: z.array(audLadderSchema).nullable().optional(),
    content_delivery_type: optString,
    content_type: optString,
    format_type: optString,
    is_adult_product: optBoolean,
    issue_date: optString,
    release_date: optString,
    publication_datetime: optString,
    language: optString,
    merchandising_summary: optString,
    publisher_summary: optString,
    short_description: optString,
    publisher_name: optString,
    product_images: z.record(z.string(), z.string().nullable()).nullable().optional(),
    rating: audRatingSchema.nullable().optional(),
    runtime_length_min: optNumber,
  })
  .loose();
export type AudProductWire = z.infer<typeof audProductSchema>;

export const audProductsResponseSchema = z
  .object({
    products: z.array(audProductSchema).nullable().optional(),
    total_results: optNumber,
    response_groups: z.array(z.string()).nullable().optional(),
  })
  .loose();
export type AudProductsResponseWire = z.infer<typeof audProductsResponseSchema>;
