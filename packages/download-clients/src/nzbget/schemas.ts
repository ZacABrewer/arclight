/**
 * Zod shapes of the NZBGet JSON-RPC responses Media-Tron reads. Only the fields we use are
 * declared; everything else is stripped. 64-bit sizes arrive as Lo/Hi uint32 pairs (with an
 * MB rounding as a fallback).
 */
import { z } from 'zod';

const num = z.number();
const optNum = num.optional();
const optStr = z.string().optional();

export const NzbgetRpcEnvelope = z.object({
  result: z.unknown().optional(),
  error: z
    .object({
      name: optStr,
      code: optNum,
      message: z.string().default('unknown error'),
    })
    .nullable()
    .optional(),
});
export type NzbgetRpcEnvelope = z.infer<typeof NzbgetRpcEnvelope>;

export const NzbgetVersion = z.string();

export const NzbgetConfig = z.array(z.object({ Name: z.string(), Value: z.string() }));
export type NzbgetConfig = z.infer<typeof NzbgetConfig>;

export const NzbgetStatus = z.object({
  DownloadRate: optNum,
  DownloadRateLo: optNum,
  DownloadRateHi: optNum,
  DownloadPaused: z.boolean().optional(),
});
export type NzbgetStatus = z.infer<typeof NzbgetStatus>;

export const NzbgetGroup = z.object({
  NZBID: num,
  NZBName: z.string(),
  Category: z.string().default(''),
  Kind: optStr,
  FileSizeLo: optNum,
  FileSizeHi: optNum,
  FileSizeMB: optNum,
  RemainingSizeLo: optNum,
  RemainingSizeHi: optNum,
  RemainingSizeMB: optNum,
  PausedSizeLo: optNum,
  PausedSizeHi: optNum,
  PausedSizeMB: optNum,
  DownloadedSizeLo: optNum,
  DownloadedSizeHi: optNum,
  DownloadedSizeMB: optNum,
  Status: z.string(),
  DestDir: z.string().default(''),
  MaxPriority: optNum,
  ActiveDownloads: optNum,
});
export type NzbgetGroup = z.infer<typeof NzbgetGroup>;
export const NzbgetGroupList = z.array(NzbgetGroup);

export const NzbgetHistoryItem = z.object({
  NZBID: num,
  Name: z.string(),
  Category: z.string().default(''),
  Kind: optStr,
  FileSizeLo: optNum,
  FileSizeHi: optNum,
  FileSizeMB: optNum,
  Status: z.string(),
  DestDir: z.string().default(''),
  FinalDir: z.string().default(''),
  ParStatus: optStr,
  UnpackStatus: optStr,
  MoveStatus: optStr,
  ScriptStatus: optStr,
  DeleteStatus: optStr,
  MarkStatus: optStr,
});
export type NzbgetHistoryItem = z.infer<typeof NzbgetHistoryItem>;
export const NzbgetHistoryList = z.array(NzbgetHistoryItem);

export const NzbgetBoolean = z.boolean();
export const NzbgetAppendResult = z.number();
