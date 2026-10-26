import { request as httpRequest } from 'node:http';

// A minimal Docker Engine API client over the unix socket (or a TCP host for tests), built on
// node:http. Only what container updates need: ping, list, inspect, pull, create, start,
// stop, rename, remove.

export type DockerEndpoint = { socketPath: string } | { host: string; port: number };

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DockerError';
  }
}

/** The parts of GET /containers/{id}/json that updates read or copy. */
export interface ContainerInspect {
  Id: string;
  Name: string;
  Image: string;
  Config: Record<string, unknown> & { Image: string; Labels?: Record<string, string> | null; Env?: string[] | null };
  HostConfig: Record<string, unknown> & { NetworkMode?: string };
  NetworkSettings?: { Networks?: Record<string, Record<string, unknown>> | null };
  Mounts?: Array<{ Source?: string; Destination?: string }>;
  State?: { Running?: boolean };
}

export interface ImageInspect {
  Id: string;
  RepoDigests?: string[] | null;
  Config?: Record<string, unknown> | null;
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  Labels?: Record<string, string>;
  State?: string;
}

export class DockerClient {
  constructor(
    private readonly endpoint: DockerEndpoint,
    private readonly timeoutMs = 120_000,
  ) {}

  /** Raw call; resolves with status and body text. Rejects on transport errors only. */
  raw(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = httpRequest(
        {
          ...('socketPath' in this.endpoint ? { socketPath: this.endpoint.socketPath } : { host: this.endpoint.host, port: this.endpoint.port }),
          method,
          path,
          headers: {
            host: 'docker',
            ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Docker API timed out: ${method} ${path}`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  private async call<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
    const res = await this.raw(method, path, body);
    if ((res.status >= 200 && res.status < 300) || okStatuses.includes(res.status)) {
      if (!res.text) return undefined as T;
      try {
        return JSON.parse(res.text) as T;
      } catch {
        return res.text as T;
      }
    }
    let message = res.text;
    try {
      message = (JSON.parse(res.text) as { message?: string }).message ?? res.text;
    } catch {
      // keep the raw body
    }
    throw new DockerError(res.status, `${method} ${path.split('?')[0]}: ${res.status} ${message}`.trim());
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.raw('GET', '/_ping', undefined, 3000);
      return res.status === 200;
    } catch {
      return false;
    }
  }

  listContainers(label?: string): Promise<ContainerSummary[]> {
    const filters = label ? `&filters=${encodeURIComponent(JSON.stringify({ label: [label] }))}` : '';
    return this.call('GET', `/containers/json?all=1${filters}`);
  }

  inspectContainer(id: string): Promise<ContainerInspect> {
    return this.call('GET', `/containers/${encodeURIComponent(id)}/json`);
  }

  inspectImage(ref: string): Promise<ImageInspect> {
    return this.call('GET', `/images/${encodeURIComponent(ref)}/json`);
  }

  /** POST /images/create streams progress; an `error` line in the stream is a failure. */
  async pull(repository: string, tag: string): Promise<void> {
    const res = await this.raw('POST', `/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(tag)}`, undefined, 30 * 60_000);
    if (res.status < 200 || res.status >= 300) throw new DockerError(res.status, `pull ${repository}:${tag}: ${res.status} ${res.text.slice(0, 300)}`);
    for (const line of res.text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as { error?: string };
        if (msg.error) throw new DockerError(500, `pull ${repository}:${tag}: ${msg.error}`);
      } catch (err) {
        if (err instanceof DockerError) throw err;
      }
    }
  }

  async createContainer(name: string, body: Record<string, unknown>): Promise<string> {
    const out = await this.call<{ Id: string }>('POST', `/containers/create?name=${encodeURIComponent(name)}`, body);
    return out.Id;
  }

  async start(id: string): Promise<void> {
    await this.call('POST', `/containers/${encodeURIComponent(id)}/start`, undefined, [304]);
  }

  async stop(id: string, seconds = 30): Promise<void> {
    await this.call('POST', `/containers/${encodeURIComponent(id)}/stop?t=${seconds}`, undefined, [304]);
  }

  async rename(id: string, name: string): Promise<void> {
    await this.call('POST', `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`);
  }

  async remove(id: string): Promise<void> {
    await this.call('DELETE', `/containers/${encodeURIComponent(id)}?force=1`, undefined, [404]);
  }
}
