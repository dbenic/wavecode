/**
 * Minimal HTTP client for talking to the WaveCode daemon from the QA agent.
 *
 * The QA agent and the WaveCode daemon may run on different machines (e.g.
 * QA on your laptop, WaveCode on a server reachable over Tailscale), so we
 * always go through the REST API rather than touching SQLite or the
 * filesystem directly.
 */

interface AgentSummary {
  id: string;
  name: string;
  runtime: string;
  workspace: string | null;
}

export interface PostDocResult {
  ok: boolean;
  path: string;
  slug: string;
  url: string;
}

export class WaveCodeClient {
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor(opts: { baseUrl: string; token?: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
  }

  /** Look up an agent by id or by name (case-insensitive exact match). */
  async findAgent(idOrName: string): Promise<AgentSummary | null> {
    const agents = await this.request<AgentSummary[]>('GET', '/api/agents');
    const direct = agents.find((a) => a.id === idOrName);
    if (direct) return direct;
    const byName = agents.find((a) => a.name.toLowerCase() === idOrName.toLowerCase());
    return byName ?? null;
  }

  async writeAgentDoc(opts: {
    agentId: string;
    filename: string;
    content: string;
    subdir?: string;
  }): Promise<PostDocResult> {
    return this.request<PostDocResult>(
      'POST',
      `/api/agents/${encodeURIComponent(opts.agentId)}/docs`,
      {
        filename: opts.filename,
        content: opts.content,
        subdir: opts.subdir,
      },
    );
  }

  private async request<T>(method: string, pathPart: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const res = await fetch(`${this.baseUrl}${pathPart}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`WaveCode ${method} ${pathPart} failed: HTTP ${res.status} ${text}`);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

/**
 * Build a public-facing URL for a doc, stripping any internal-only path parts.
 * Used to print clickable URLs at the end of a QA run.
 */
export function buildDocUrl(baseUrl: string, slug: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/docs/${slug}`;
}
