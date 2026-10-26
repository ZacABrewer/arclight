import type { z } from 'zod';
import { ErrorResponse } from '@media-tron/shared';

export const API_BASE = '/api/v1';

/** A non-2xx response from the api. `code` comes from the shared ErrorResponse body when present. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly path: string;

  constructor(status: number, message: string, path: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

/** The response did not match the shared contract: api and web have drifted. */
export class ContractError extends Error {
  readonly path: string;
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(path: string, issues: readonly z.core.$ZodIssue[]) {
    super(`Response from ${path} does not match the contract (${issues.length} issue${issues.length === 1 ? '' : 's'})`);
    this.name = 'ContractError';
    this.path = path;
    this.issues = issues;
  }
}

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  /** Serialised as JSON with the matching content-type. */
  json?: unknown;
  body?: BodyInit | null;
  /** Query-string parameters; undefined/null values are dropped. */
  query?: QueryParams | undefined;
}

/**
 * The one way the web talks to the api. Every response is parsed against the shared Zod
 * schema so a contract drift fails loudly instead of rendering `undefined`.
 * Pass `null` as the schema for endpoints that return no body (204).
 */
export async function request<T extends z.ZodType>(path: string, schema: T, init?: RequestOptions): Promise<z.infer<T>>;
export async function request(path: string, schema: null, init?: RequestOptions): Promise<void>;
export async function request(path: string, schema: z.ZodType | null, init: RequestOptions = {}): Promise<unknown> {
  const { json, query, headers, body: rawBody, ...rest } = init;
  const url = buildUrl(path, query);
  const finalHeaders = new Headers(headers);
  if (!finalHeaders.has('accept')) finalHeaders.set('accept', 'application/json');
  let body: BodyInit | null = rawBody ?? null;
  if (json !== undefined) {
    finalHeaders.set('content-type', 'application/json');
    body = JSON.stringify(json);
  }

  const res = await fetch(url, { credentials: 'same-origin', ...rest, headers: finalHeaders, body });

  if (!res.ok) throw await toApiError(res, path);
  if (schema === null || res.status === 204) return undefined;

  const data: unknown = await res.json();
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ContractError(path, parsed.error.issues);
  return parsed.data;
}

export function buildUrl(path: string, query?: QueryParams): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const s = qs.toString();
  return `${API_BASE}${path}${s ? `?${s}` : ''}`;
}

async function toApiError(res: Response, path: string): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`.trim();
  let code: string | undefined;
  try {
    const parsed = ErrorResponse.safeParse(await res.json());
    if (parsed.success) {
      message = parsed.data.error;
      code = parsed.data.code;
    }
  } catch {
    // Body was empty or not JSON: keep the status text.
  }
  return new ApiError(res.status, message, path, code);
}

/** Human-readable message for any error thrown by `request` (used by toasts and error views). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
