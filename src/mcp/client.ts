/**
 * Minimal REST client for the WaveCode daemon, used by the MCP server.
 * All MCP tools go through this client — the MCP layer never touches the
 * database or tmux directly, so it works against local and remote daemons.
 */

export interface WaveCodeClientOptions {
  baseUrl: string;
  token?: string | null;
  fetchImpl?: typeof fetch;
}

export class WaveCodeApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'WaveCodeApiError';
  }
}

export class WaveCodeClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WaveCodeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetchImpl(`${this.baseUrl}/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      const message =
        (parsed as { error?: string } | null)?.error ?? `HTTP ${res.status} from ${path}`;
      throw new WaveCodeApiError(message, res.status);
    }

    return parsed as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
}
