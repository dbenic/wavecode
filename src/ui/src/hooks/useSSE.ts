import { useEffect, useRef } from 'react';
import { buildEventStreamUrl, useAuthState } from './useApi';
import { SSE_EVENT_TYPES, type KnownSSEEventType } from '../sse-events';

export interface SSEEvent {
  id: number;
  type: KnownSSEEventType | string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

type EventHandler = (event: SSEEvent) => void;

/**
 * One event stream per tab, shared by every subscriber, and closed while the
 * tab is hidden.
 *
 * Browsers allow six HTTP/1.1 connections per host. An EventSource holds one
 * for as long as the page lives, so a page with two subscribers in three tabs
 * used them all and the next load of countix-dev hung until a tab was closed.
 * Now a tab holds at most one, and none once it has been in the background
 * for a few seconds; on return it reconnects with the last event id and the
 * server replays what was missed.
 */
const HIDDEN_CLOSE_MS = 5_000;
const MAX_RECONNECT_MS = 30_000;

const handlers = new Set<{ current: EventHandler }>();
let source: EventSource | null = null;
let sourceToken: string | null = null;
let lastEventId = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityHooked = false;

function tabHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function closeSource(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  source?.close();
  source = null;
}

function connect(token: string | null): void {
  if (handlers.size === 0 || tabHidden()) return;
  if (source && sourceToken === token) return;
  closeSource();
  sourceToken = token;
  const es = new EventSource(buildEventStreamUrl(window.location.origin, lastEventId, token));
  source = es;

  es.onopen = () => { reconnectDelay = 1000; };
  es.onerror = () => {
    if (source !== es) return;
    closeSource();
    reconnectTimer = setTimeout(() => connect(token), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
  };
  for (const type of SSE_EVENT_TYPES) {
    es.addEventListener(type, (e: MessageEvent) => {
      let data: SSEEvent;
      try { data = JSON.parse(e.data) as SSEEvent; } catch { return; }
      lastEventId = data.id;
      for (const h of handlers) {
        try { h.current(data); } catch { /* one subscriber's error must not stop the others */ }
      }
    });
  }
}

function onVisibilityChange(): void {
  if (tabHidden()) {
    if (!hiddenTimer) {
      hiddenTimer = setTimeout(() => {
        hiddenTimer = null;
        if (tabHidden()) closeSource();
      }, HIDDEN_CLOSE_MS);
    }
    return;
  }
  if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null; }
  reconnectDelay = 1000;
  connect(sourceToken);
}

function hookVisibility(): void {
  if (visibilityHooked || typeof document === 'undefined') return;
  visibilityHooked = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
}

export function useSSE(onEvent: EventHandler) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  const auth = useAuthState();

  useEffect(() => {
    if (!auth.loaded) return;
    if (auth.method === 'token' && !auth.token) return;

    hookVisibility();
    handlers.add(handlerRef);
    connect(auth.token);

    return () => {
      handlers.delete(handlerRef);
      if (handlers.size === 0) closeSource();
    };
  }, [auth.loaded, auth.method, auth.token]);
}

/** How many streams this tab holds right now (0 or 1); for tests and the Health panel. */
export function openEventStreams(): number {
  return source ? 1 : 0;
}

export function resetEventStreamForTest(): void {
  closeSource();
  handlers.clear();
  sourceToken = null;
  lastEventId = 0;
  reconnectDelay = 1000;
  if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null; }
}
