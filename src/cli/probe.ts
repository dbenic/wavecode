export const DEFAULT_PROBE_URL = 'https://httpbin.org/get';

export type ProbeResult =
  | { ok: true; data: { status: number; url: string } }
  | { ok: false; error: string };

export interface ProbeUrlOptions {
  fetchImpl?: typeof fetch;
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

export async function probeUrl(
  url: string = DEFAULT_PROBE_URL,
  options: ProbeUrlOptions = {},
): Promise<ProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `invalid URL: ${url}` };
  }

  if (!isHttpUrl(parsed)) {
    return { ok: false, error: `only http(s) URLs are allowed (got ${parsed.protocol})` };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl(url, { method: 'GET' });
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, data: { status: response.status, url } };
    }
    return { ok: false, error: `HTTP ${response.status}` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: reason };
  }
}
