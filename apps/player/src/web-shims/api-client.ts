// Stands in for apps/web/src/api/client.ts inside the app bundle (vite.config.ts → webShims).
// Same exports, but requests go to the signed-in server with the device token (core/api.ts)
// instead of the page's own origin with a cookie.
import type { z } from 'zod';
import { getSession } from '../core/session';
import { ApiError, ContractError, buildApiUrl, errorMessage, request as appRequest, setUnauthorizedHandler, type QueryParams, type RequestOptions } from '../core/api';

export { ApiError, ContractError, errorMessage, setUnauthorizedHandler };
export type { QueryParams, RequestOptions };

/** The api root of the active server ("" before sign-in). */
export const API_BASE = '';

/** No admin pages in the app, so nothing to send to two-factor setup. */
export function setTwoFactorSetupHandler(_handler: (() => void) | null): void {}

export async function request<T extends z.ZodType>(path: string, schema: T, init?: RequestOptions): Promise<z.infer<T>>;
export async function request(path: string, schema: null, init?: RequestOptions): Promise<void>;
export async function request(path: string, schema: z.ZodType | null, init: RequestOptions = {}): Promise<unknown> {
  return schema === null ? appRequest(path, null, init) : appRequest(path, schema, init);
}

/** Absolute URL on the active server (used by the web's streamUrl / beacon helpers). */
export function buildUrl(path: string, query?: QueryParams): string {
  const s = getSession();
  return buildApiUrl(s?.serverUrl ?? '', path, query);
}
