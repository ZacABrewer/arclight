// Test-only helper (not exported from the package): a scripted stand-in for `fetch`.

export interface FakeReply {
  status?: number;
  body: string;
  contentType?: string;
}

export type FakeHandler = (url: URL, callIndex: number) => FakeReply | Error | Promise<FakeReply | Error>;

export interface FakeFetch {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
}

export function fakeFetch(handler: FakeHandler | FakeReply): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const reply = typeof handler === 'function' ? await handler(new URL(url), calls.length - 1) : handler;
    if (reply instanceof Error) throw reply;
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: { 'content-type': reply.contentType ?? 'application/rss+xml; charset=utf-8' },
    });
  };
  return { fetch: impl, calls };
}

/** Route `t=caps` to one body and everything else to another. */
export function capsAndSearch(capsBody: string, searchBody: string | ((url: URL, i: number) => FakeReply)): FakeHandler {
  return (url, i) => {
    if (url.searchParams.get('t') === 'caps') return { body: capsBody };
    return typeof searchBody === 'string' ? { body: searchBody } : searchBody(url, i);
  };
}
