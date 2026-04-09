import { useState, useCallback, useRef, useEffect } from 'react';

const BASE_URL = '/api';
const ACCESS_TOKEN_STORAGE_KEY = 'wavecode.access_token';

// --- Global error listeners for ErrorBanner ---
type ErrorListener = (msg: string) => void;
const errorListeners = new Set<ErrorListener>();

export type AuthMethod = 'tailscale' | 'token';

export interface PublicAuthStatus {
  method: AuthMethod;
  tokenConfigured: boolean;
}

export interface AuthState {
  method: AuthMethod | null;
  tokenConfigured: boolean;
  token: string | null;
  unauthorized: boolean;
  loaded: boolean;
}

type AuthListener = (state: AuthState) => void;
const authListeners = new Set<AuthListener>();

function readStoredAccessToken(): string | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

let authState: AuthState = {
  method: null,
  tokenConfigured: false,
  token: readStoredAccessToken(),
  unauthorized: false,
  loaded: false,
};

export function onApiError(listener: ErrorListener): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

function notifyError(msg: string): void {
  for (const listener of errorListeners) {
    listener(msg);
  }
}

function emitAuthState(nextState: Partial<AuthState>): void {
  authState = { ...authState, ...nextState };
  for (const listener of authListeners) {
    listener(authState);
  }
}

export function onAuthStateChange(listener: AuthListener): () => void {
  authListeners.add(listener);
  listener(authState);
  return () => authListeners.delete(listener);
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

export function buildAuthHeaders(
  token: string | null,
  headers?: HeadersInit,
): Record<string, string> {
  const merged = headersToRecord(headers);
  if (token) {
    merged.Authorization = `Bearer ${token}`;
  }
  return merged;
}

export function buildEventStreamUrl(
  origin: string,
  lastEventId: number,
  token: string | null,
): string {
  const url = new URL(`${BASE_URL}/events`, origin);
  if (lastEventId > 0) {
    url.searchParams.set('lastEventId', String(lastEventId));
  }
  if (token) {
    url.searchParams.set('access_token', token);
  }
  return url.toString();
}

export function getAccessToken(): string | null {
  return authState.token;
}

export function setAccessToken(token: string): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
    } catch {
      // Ignore storage failures; keep token in memory.
    }
  }

  emitAuthState({
    token,
    unauthorized: false,
  });
}

export function clearAccessToken(): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
  }

  emitAuthState({
    token: null,
    unauthorized: false,
  });
}

export async function fetchAuthStatus(): Promise<PublicAuthStatus> {
  const res = await fetch(`${BASE_URL}/auth/status`);
  if (!res.ok) {
    emitAuthState({ loaded: true });
    throw new Error(`Failed to load auth status (${res.status})`);
  }

  const status = await res.json() as PublicAuthStatus;
  emitAuthState({
    method: status.method,
    tokenConfigured: status.tokenConfigured,
    loaded: true,
  });
  return status;
}

export async function verifyAccessToken(token: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/auth/verify`, {
    headers: buildAuthHeaders(token),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? 'Invalid access token');
  }

  setAccessToken(token);
}

// --- Core request function ---

async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    // Only set Content-Type for requests with a body
    const headers: Record<string, string> = {};
    if (options?.body) {
      headers['Content-Type'] = 'application/json';
    }
    res = await fetch(`${BASE_URL}${path}`, {
      headers: buildAuthHeaders(authState.token, { ...headers, ...options?.headers }),
      ...options,
    });
  } catch (e) {
    const msg = (e as Error).message || 'Network error';
    notifyError(msg);
    throw new Error(msg);
  }

  if (!res.ok) {
    if (res.status === 401) {
      emitAuthState({ unauthorized: true });
      throw new Error('Unauthorized');
    }

    const body = await res.json().catch(() => ({ error: res.statusText }));
    const msg = body.error ?? `HTTP ${res.status}`;
    notifyError(msg);
    throw new Error(msg);
  }

  return res.json();
}

export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PUT',
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}

/**
 * Upload a file via multipart form data.
 * Does NOT set Content-Type (browser adds boundary automatically).
 */
export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      body: formData,
      headers: buildAuthHeaders(authState.token),
    });
  } catch (e) {
    const msg = (e as Error).message || 'Upload failed';
    notifyError(msg);
    throw new Error(msg);
  }

  if (!res.ok) {
    if (res.status === 401) {
      emitAuthState({ unauthorized: true });
      throw new Error('Unauthorized');
    }

    const body = await res.json().catch(() => ({ error: res.statusText }));
    const msg = body.error ?? `Upload failed: HTTP ${res.status}`;
    notifyError(msg);
    throw new Error(msg);
  }

  return res.json();
}

export function useApiCall<T>() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-clear error after 5s
  useEffect(() => {
    return () => { if (clearTimerRef.current) clearTimeout(clearTimerRef.current); };
  }, []);

  const call = useCallback(async (fn: () => Promise<T>): Promise<T | null> => {
    setLoading(true);
    setError(null);
    try {
      const result = await fn();
      return result;
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      clearTimerRef.current = setTimeout(() => setError(null), 8000);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { call, loading, error, clearError };
}

/**
 * Hook to subscribe to global API errors for the ErrorBanner.
 */
export function useGlobalApiError() {
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = onApiError((msg) => {
      // Clear any existing timer to prevent stacking
      if (timerRef.current) clearTimeout(timerRef.current);
      setError(msg);
      timerRef.current = setTimeout(() => setError(null), 5000);
    });
    return () => {
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return error;
}

export function useAuthState(): AuthState {
  const [state, setState] = useState<AuthState>(authState);

  useEffect(() => onAuthStateChange(setState), []);

  return state;
}
