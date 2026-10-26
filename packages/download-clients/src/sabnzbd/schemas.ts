/**
 * Zod shapes of the SABnzbd API responses (output=json). Only the fields the client reads
 * are declared; everything else is stripped.
 */
import { z } from 'zod';

/** SAB sends most sizes and percentages as strings ("1277.65"); accept both. */
const numeric = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const n = typeof value === 'number' ? value : Number(value.trim() === '' ? '0' : value.trim());
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: 'custom', message: `not a number: ${String(value)}` });
    return z.NEVER;
  }
  return n;
});

export const SabVersion = z.object({ version: z.string() });
export type SabVersion = z.infer<typeof SabVersion>;

export const SabQueueSlot = z.object({
  nzo_id: z.string().min(1),
  filename: z.string(),
  cat: z.string().nullish(),
  mb: numeric.optional(),
  mbleft: numeric.optional(),
  percentage: numeric.optional(),
  status: z.string(),
  timeleft: z.string().optional(),
});
export type SabQueueSlot = z.infer<typeof SabQueueSlot>;

export const SabQueue = z.object({
  queue: z.object({
    paused: z.boolean().optional(),
    status: z.string().optional(),
    slots: z.array(SabQueueSlot).default([]),
  }),
});
export type SabQueue = z.infer<typeof SabQueue>;

export const SabHistorySlot = z.object({
  nzo_id: z.string().min(1),
  name: z.string(),
  category: z.string().nullish(),
  bytes: numeric.optional(),
  status: z.string(),
  fail_message: z.string().nullish(),
  storage: z.string().nullish(),
});
export type SabHistorySlot = z.infer<typeof SabHistorySlot>;

export const SabHistory = z.object({
  history: z.object({
    slots: z.array(SabHistorySlot).default([]),
  }),
});
export type SabHistory = z.infer<typeof SabHistory>;

export const SabCategory = z.object({
  name: z.string(),
  dir: z.string().nullish(),
});
export type SabCategory = z.infer<typeof SabCategory>;

export const SabConfig = z.object({
  config: z.object({
    misc: z.object({
      complete_dir: z.string().nullish(),
      /** Up to 4.2: "" / "0" keep all, "-1" keep none, "<n>" jobs, "<n>d" days. */
      history_retention: z.union([z.string(), z.number()]).nullish(),
      /** 4.3+: "all", "number-archive", "days-archive", "number-delete", "days-delete", "all-archive", "all-delete". */
      history_retention_option: z.string().nullish(),
    }),
    categories: z.array(SabCategory).default([]),
  }),
});
export type SabConfig = z.infer<typeof SabConfig>;
export type SabMisc = SabConfig['config']['misc'];

/** Generic `{status, nzo_ids}` acknowledgement (addfile, queue delete, pause, ...). */
export const SabStatusReply = z.object({
  status: z.boolean().optional(),
  nzo_ids: z.array(z.string()).optional(),
});
export type SabStatusReply = z.infer<typeof SabStatusReply>;
